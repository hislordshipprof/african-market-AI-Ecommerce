import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAppRuntimeLogin, authPrisma, platform, platformAdmin, platformAdminTransaction, storeScoped, storeScopedTransaction } from "../../db";
import { auth } from "../../auth";
import { resolveIngredients } from "../../catalog/ingredients";
import type { CatalogFixture, PastOrder } from "./types";
import type { MasterCatalogRow } from "./fingerprint";

const LEASE_DIR = join(tmpdir(), "shopper-assistant-eval-leases");
const STALE_MS = 90_000;

export interface CreatedEvalStores {
  runId: string;
  storeAId: string;
  storeBId: string;
  slugA: string;
  slugB: string;
  ids: Map<string, { listingId: string; variants: Map<string, string> }>;
  masterCatalog: MasterCatalogRow[];
}

export async function assertRuntimeRole(): Promise<string> {
  await assertAppRuntimeLogin();
  return "app_runtime";
}

export async function createEvalStores(fixture: CatalogFixture): Promise<CreatedEvalStores> {
  await assertRuntimeRole();
  const ids = [...new Set(fixture.listings.map((listing) => listing.masterProductId))];
  const products = await platform.masterProduct.findMany({
    where: { id: { in: ids } },
    include: { synonyms: { select: { term: true } } },
  });
  if (products.length !== ids.length) {
    throw new Error("run pnpm db:seed");
  }
  const masterCatalog: MasterCatalogRow[] = products.map((product) => ({
    id: product.id,
    name: product.name,
    categoryId: product.categoryId,
    synonyms: product.synonyms.map((synonym) => synonym.term),
  }));
  const runId = randomBytes(8).toString("hex");
  const slugA = `golden-eval-a-${runId}`;
  const slugB = `golden-eval-b-${runId}`;
  const storeA = await platformAdmin.store.create({
    data: storeData(slugA, fixture),
  });
  let storeBId = "";
  try {
    const storeB = await platformAdmin.store.create({
      data: storeData(slugB, fixture),
    });
    storeBId = storeB.id;
    writeLease(runId, [slugA, slugB]);
    await seedIngredients(fixture.ingredients ?? []);
    const created = new Map<string, { listingId: string; variants: Map<string, string> }>();
    for (const listing of fixture.listings) {
      const storeId = listing.store === "A" ? storeA.id : storeB.id;
      const row = await storeScoped(storeId).listing.create({
        data: {
          storeId,
          masterProductId: listing.masterProductId,
          price: listing.priceCents,
          stockMode: listing.stockMode,
          qty: listing.qty,
          status: listing.status,
          confidence: listing.confidence,
          active: listing.active,
          maxPerOrder: listing.maxPerOrder,
          frozen: false,
          perishable: false,
        },
      });
      const variants = new Map<string, string>();
      for (const variant of listing.variants) {
        const saved = await storeScoped(storeId).listingVariant.create({
          data: {
            listingId: row.id,
            label: variant.label,
            price: variant.priceCents,
            weightG: variant.weightG,
          },
        });
        variants.set(variant.key, saved.id);
      }
      if (listing.attributes) await seedAttributes(storeId, row.id, listing.attributes);
      created.set(listing.key, { listingId: row.id, variants });
    }
    return { runId, storeAId: storeA.id, storeBId, slugA, slugB, ids: created, masterCatalog };
  } catch (error) {
    await deleteEvalStore(storeA.id).catch(() => {});
    if (storeBId) await deleteEvalStore(storeBId).catch(() => {});
    throw error;
  }
}

/** Ingredients are platform rows shared across runs; creating them again is a no-op. */
async function seedIngredients(ingredients: NonNullable<CatalogFixture["ingredients"]>) {
  if (ingredients.length === 0) return;
  await platformAdminTransaction(async (tx) => {
    await tx.ingredient.createMany({ data: ingredients.map((item) => ({ name: item.name })), skipDuplicates: true });
    const rows = await tx.ingredient.findMany({ where: { name: { in: ingredients.map((item) => item.name) } } });
    const ids = new Map(rows.map((row) => [row.name, row.id]));
    await tx.ingredientSynonym.createMany({
      data: ingredients.flatMap((item) => item.synonyms.map((term) => ({ term, ingredientId: ids.get(item.name)! }))),
      skipDuplicates: true,
    });
  });
}

async function seedAttributes(storeId: string, listingId: string, attributes: NonNullable<CatalogFixture["listings"][number]["attributes"]>) {
  await storeScopedTransaction(storeId, async (tx) => {
    const resolved = await resolveIngredients(tx, attributes.ingredients, { create: false });
    if (resolved.unmatched.length > 0) throw new Error(`Eval ingredients missing: ${resolved.unmatched.join(", ")}`);
    await tx.listingAttributes.create({
      data: {
        listingId,
        storeId,
        ingredientsStatus: "known",
        allergensStatus: "known",
        allergens: attributes.allergens,
        dietaryStatus: "known",
        dietaryClaims: attributes.dietary,
      },
    });
    await tx.listingIngredient.createMany({ data: resolved.ids.map((ingredientId) => ({ listingId, ingredientId, storeId })) });
  });
}

function storeData(slug: string, fixture: CatalogFixture) {
  return {
    slug,
    name: fixture.store.name,
    themePreset: "palm-and-shea",
    timezone: fixture.store.timezone,
    hours: fixture.store.hours,
    minimumOrderCents: fixture.store.minimumOrderCents,
    pickupEnabled: fixture.store.pickupEnabled,
    status: "active",
  };
}

export async function deleteEvalStore(storeId: string): Promise<void> {
  await storeScoped(storeId).order.deleteMany({});
  await storeScoped(storeId).customer.deleteMany({});
  await storeScoped(storeId).cart.deleteMany({});
  await storeScoped(storeId).listing.deleteMany({});
  await platformAdmin.store.delete({ where: { id: storeId } }).catch(async () => {
    const left = await platformAdmin.store.findUnique({ where: { id: storeId } });
    if (left) throw new Error(`Eval store ${storeId} was not removed.`);
  });
}

export async function deleteOwnedStores(created: CreatedEvalStores): Promise<void> {
  await deleteEvalStore(created.storeAId);
  await deleteEvalStore(created.storeBId);
}

export function writeLease(runId: string, slugs: string[], heartbeat = Date.now()): void {
  mkdirSync(LEASE_DIR, { recursive: true });
  const path = join(LEASE_DIR, `${runId}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ runId, pid: process.pid, heartbeat, slugs }));
  renameSync(tmp, path);
}

export function leaseFresh(runId: string, now = Date.now()): boolean {
  const path = join(LEASE_DIR, `${runId}.json`);
  if (!existsSync(path)) return false;
  try {
    const body = JSON.parse(readFileSync(path, "utf8")) as { heartbeat?: unknown };
    return typeof body.heartbeat === "number" && now - body.heartbeat < STALE_MS;
  } catch {
    return false;
  }
}

const OWNED_SLUG = /^golden-eval-[ab]-([0-9a-f]{16})$/;

/** Removes eval stores whose lease is stale. A fresh lease is another live run. */
export async function sweepAbandonedEvalStores(ownRunId: string): Promise<void> {
  const stores = await platformAdmin.store.findMany({
    where: { slug: { startsWith: "golden-eval-" } },
    select: { id: true, slug: true, createdAt: true },
  });
  for (const store of stores) {
    // The run id lives in the slug: store fields reach the model's context, so they must not vary per run.
    const runId = OWNED_SLUG.exec(store.slug)?.[1];
    if (!runId || runId === ownRunId) continue;
    if (leaseFresh(runId)) continue;
    const age = Date.now() - store.createdAt.getTime();
    const leased = existsSync(join(LEASE_DIR, `${runId}.json`));
    if (!leased && age < 60 * 60 * 1000) continue;
    await deleteEvalStore(store.id);
  }
}

const AUTH_ORIGIN = "http://localhost:3000";

export interface EvalShopper {
  /** The session cookie for the chat request. */
  cookie: string;
  remove: () => Promise<void>;
}

/**
 * A real account signed in through the auth handler, with the case's orders placed: its own at store A or B,
 * and another customer's at the same store, so "my usual" is checked against what it must not see.
 */
export async function signInEvalShopper(created: CreatedEvalStores, orders: PastOrder[]): Promise<EvalShopper> {
  const email = `golden-eval-${created.runId}-${randomBytes(4).toString("hex")}@example.com`;
  const password = `Eval-${randomBytes(12).toString("hex")}`;
  const call = (path: string, body: Record<string, string>) => auth.handler(new Request(`${AUTH_ORIGIN}/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
    body: JSON.stringify(body),
  }));
  const signedUp = await call("sign-up/email", { email, password, name: "Eval Shopper" });
  if (!signedUp.ok) throw new Error(`Eval shopper sign-up failed: ${signedUp.status}`);
  const user = await authPrisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });
  const remove = async () => {
    for (const storeId of [created.storeAId, created.storeBId]) {
      await storeScoped(storeId).order.deleteMany({ where: { customer: { OR: [{ userId: user.id }, { email }] } } });
      await storeScoped(storeId).customer.deleteMany({ where: { OR: [{ userId: user.id }, { email }] } });
    }
    await authPrisma.session.deleteMany({ where: { userId: user.id } });
    await authPrisma.account.deleteMany({ where: { userId: user.id } });
    await authPrisma.user.delete({ where: { id: user.id } });
  };
  try {
    const signedIn = await call("sign-in/email", { email, password });
    if (!signedIn.ok) throw new Error(`Eval shopper sign-in failed: ${signedIn.status}`);
    const cookie = (signedIn.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
    let number = 7000;
    for (const order of orders) {
      const storeId = order.store === "A" ? created.storeAId : created.storeBId;
      const scoped = storeScoped(storeId);
      const customer = order.customer === "self"
        ? await scoped.customer.findFirst({ where: { userId: user.id } }) ?? await scoped.customer.create({ data: { storeId, userId: user.id, name: "Eval Shopper" } })
        : await scoped.customer.create({ data: { storeId, name: "Other Shopper", email } });
      const lines = order.lines.map((line) => {
        const variantId = created.ids.get(line.listingKey)?.variants.get(line.variantKey);
        if (!variantId) throw new Error(`Eval past order names unknown variant ${line.variantKey}.`);
        return { variantId, qty: line.qty };
      });
      number += 1;
      const placed = await scoped.order.create({
        data: {
          storeId,
          number,
          customerId: customer.id,
          status: "COMPLETED",
          fulfillment: "pickup",
          subtotalCents: 0,
          bufferCents: 0,
          totalAuthorizedCents: 0,
          totalCents: 0,
          trackingToken: `golden-eval-${randomBytes(12).toString("hex")}`,
          createdAt: new Date(Date.now() - number * 60_000),
        },
      });
      await scoped.orderLine.createMany({
        data: lines.map((line) => ({ storeId, orderId: placed.id, listingVariantId: line.variantId, qtyOrdered: line.qty, unitPriceCents: 0 })),
      });
    }
    return { cookie, remove };
  } catch (error) {
    await remove().catch(() => {});
    throw error;
  }
}
