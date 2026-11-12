import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAppRuntimeLogin, platform, platformAdmin, storeScoped } from "../../db";
import type { CatalogFixture } from "./types";
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
    data: storeData(slugA, fixture, runId),
  });
  let storeBId = "";
  try {
    const storeB = await platformAdmin.store.create({
      data: storeData(slugB, fixture, runId),
    });
    storeBId = storeB.id;
    writeLease(runId, [slugA, slugB]);
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
      created.set(listing.key, { listingId: row.id, variants });
    }
    return { runId, storeAId: storeA.id, storeBId, slugA, slugB, ids: created, masterCatalog };
  } catch (error) {
    await deleteEvalStore(storeA.id).catch(() => {});
    if (storeBId) await deleteEvalStore(storeBId).catch(() => {});
    throw error;
  }
}

function storeData(slug: string, fixture: CatalogFixture, runId: string) {
  return {
    slug,
    name: fixture.store.name,
    themePreset: "palm-and-shea",
    timezone: fixture.store.timezone,
    hours: fixture.store.hours,
    minimumOrderCents: fixture.store.minimumOrderCents,
    pickupEnabled: fixture.store.pickupEnabled,
    deliveryInfo: `eval-run:${runId}`,
    status: "active",
  };
}

export async function deleteEvalStore(storeId: string): Promise<void> {
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

/** Removes eval stores whose lease is stale. A fresh lease is another live run. */
export async function sweepAbandonedEvalStores(ownRunId: string): Promise<void> {
  const stores = await platformAdmin.store.findMany({
    where: { slug: { startsWith: "golden-eval-" } },
    select: { id: true, deliveryInfo: true, createdAt: true },
  });
  for (const store of stores) {
    if (!store.deliveryInfo?.startsWith("eval-run:")) continue;
    const runId = store.deliveryInfo.slice("eval-run:".length);
    if (runId === "" || runId === ownRunId) continue;
    if (leaseFresh(runId)) continue;
    const age = Date.now() - store.createdAt.getTime();
    const leased = existsSync(join(LEASE_DIR, `${runId}.json`));
    if (!leased && age < 60 * 60 * 1000) continue;
    await deleteEvalStore(store.id);
  }
}
