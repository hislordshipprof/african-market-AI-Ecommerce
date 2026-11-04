import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

import { generateTOTP } from "../../../e2e/totp";

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

vi.mock("next/headers", () => ({
  headers: async () => headerState,
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

import { serializeVariants } from "../../app/store-admin/listings/variant-form";
import { auth } from "../auth";
import { addLine, getCartWithLines, getOrCreateCart } from "../cart/service";
import { authPrisma, storeScoped } from "../db";
import { createListingAction, updateListingAction } from "./actions";
import { commitImport, generatePreview } from "./csv-import";

const hasDb = !!process.env.DATABASE_URL;
const BASE = "http://localhost:3000/api/auth";
const RUN = `w216-act-${Date.now().toString(36)}`;
const password = "Placeholder-123!";

async function authPost(path: string, body: unknown, cookies?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies) headers.cookie = cookies;
  return auth.handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

function collectCookies(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).join("; ");
}

async function signUp(email: string, name: string): Promise<void> {
  const res = await authPost("/sign-up/email", { email, password, name });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function signOut(cookies: string): Promise<void> {
  const res = await authPost("/sign-out", {}, cookies);
  expect(res.status, await res.clone().text()).toBe(200);
}

async function enrollTotp(email: string): Promise<string> {
  const signedIn = await authPost("/sign-in/email", { email, password });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  const cookies = collectCookies(signedIn);
  const enabled = await authPost("/two-factor/enable", { password }, cookies);
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  const body = await enabled.json();
  const secret = new URL(body.totpURI as string).searchParams.get("secret");
  if (!secret) throw new Error("TOTP URI has no secret");
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
  expect(verified.status, await verified.clone().text()).toBe(200);
  await signOut(collectCookies(verified) || cookies);
  return secret;
}

async function waitForNextTotpWindow(): Promise<void> {
  const period = 30_000;
  const remain = period - (Date.now() % period);
  await new Promise((resolve) => setTimeout(resolve, remain + 1100));
}

async function challengedSession(email: string, secret: string): Promise<{ pending: string; verified: string }> {
  const signedIn = await authPost("/sign-in/email", { email, password });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  const body = await signedIn.json();
  expect(body.twoFactorRedirect).toBe(true);
  const pending = collectCookies(signedIn);
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, pending);
  expect(verified.status, await verified.clone().text()).toBe(200);
  return { pending, verified: collectCookies(verified) || pending };
}

function asStore(slug: string, cookies: string) {
  headerState.set("cookie", cookies);
  headerState.set("x-store-slug", slug);
}

function saveForm(listingId: string, name: string, variants: unknown, price = 800): FormData {
  const fd = new FormData();
  fd.set("listingId", listingId);
  fd.set("customName", name);
  fd.set("price", String(price));
  fd.set("stockMode", "counted");
  fd.set("qty", "4");
  fd.set("frozen", "false");
  fd.set("perishable", "false");
  fd.set("maxPerOrder", "");
  fd.set("masterProductId", "");
  fd.set("variants", JSON.stringify(variants));
  return fd;
}

describe.skipIf(!hasDb)("placeholder weight actions (real auth, lane DB)", () => {
  const ownerEmail = `ph-owner-${RUN}@example.com`;
  const otherEmail = `ph-other-${RUN}@example.com`;
  const storeASlug = `ph-a-${RUN}`;
  const storeBSlug = `ph-b-${RUN}`;
  let storeAId = "";
  let storeBId = "";
  let ownerId = "";
  let ownerSecret = "";
  let ownerCookies = "";
  let otherCookies = "";

  beforeAll(async () => {
    await signUp(ownerEmail, "Placeholder Owner");
    await signUp(otherEmail, "Placeholder Other");
    const owner = await authPrisma.user.findFirstOrThrow({ where: { email: ownerEmail } });
    const other = await authPrisma.user.findFirstOrThrow({ where: { email: otherEmail } });
    ownerId = owner.id;
    storeAId = crypto.randomUUID();
    storeBId = crypto.randomUUID();

    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeAId}, ${"PH A " + RUN}, ${storeASlug}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeBId}, ${"PH B " + RUN}, ${storeBSlug}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeAId}, ${owner.id}, 'owner', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeBId}, ${other.id}, 'owner', now())`;
    });

    ownerSecret = await enrollTotp(ownerEmail);
    const otherSecret = await enrollTotp(otherEmail);
    await waitForNextTotpWindow();
    ownerCookies = (await challengedSession(ownerEmail, ownerSecret)).verified;
    otherCookies = (await challengedSession(otherEmail, otherSecret)).verified;
  }, 90_000);

  afterAll(async () => {
    const emails = [ownerEmail, otherEmail];
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM cart_lines WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM carts WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM listing_variants WHERE listing_id IN (SELECT id FROM listings WHERE store_id IN (${storeAId}, ${storeBId}))`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM stock_events WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM listing_imports WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM listings WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE store_id IN (${storeAId}, ${storeBId})`;
      for (const email of emails) {
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM verifications WHERE value LIKE ${"%" + email + "%"}`;
        await tx.$executeRaw`DELETE FROM users WHERE email = ${email}`;
      }
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${storeAId}, ${storeBId})`;
    });
  }, 30_000);

  async function importPlaceholder(name: string) {
    const preview = await generatePreview(storeAId, `name,price\n${name},8.00\n`, ownerId);
    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      { id: ownerId, email: ownerEmail },
    );
    expect(result.needsWeightCount).toBe(1);
    const listing = await storeScoped(storeAId).listing.findUniqueOrThrow({
      where: { id: result.listingIds[0] },
      include: { variants: true },
    });
    const variant = listing.variants[0]!;
    expect(variant.weightG).toBe(100);
    expect(variant.weightPlaceholder).toBe(true);
    expect(variant.price).toBe(800);
    expect(listing.price).toBe(800);
    return { listingId: listing.id, variantId: variant.id, label: variant.label };
  }

  it("an owner signed in through auth.handler clears the flag by saving a weight", async () => {
    const row = await importPlaceholder(`Clear ${RUN}`);
    asStore(storeASlug, ownerCookies);
    const result = await updateListingAction(saveForm(row.listingId, `Clear ${RUN}`, [
      { id: row.variantId, label: row.label, price: 800, weightG: 22680 },
    ]));
    expect(result).toEqual({ success: true, id: row.listingId });
    const saved = await storeScoped(storeAId).listingVariant.findUniqueOrThrow({ where: { id: row.variantId } });
    expect(saved.id).toBe(row.variantId);
    expect(saved.weightG).toBe(22680);
    expect(saved.weightPlaceholder).toBe(false);
    expect(saved.price).toBe(800);
    const listing = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: row.listingId } });
    expect(listing.price).toBe(800);

    const typed = await importPlaceholder(`Typed Hundred ${RUN}`);
    const typedResult = await updateListingAction(saveForm(typed.listingId, `Typed Hundred ${RUN}`, [
      { id: typed.variantId, label: typed.label, price: 800, weightG: 100 },
    ]));
    expect(typedResult).toEqual({ success: true, id: typed.listingId });
    const typedRow = await storeScoped(storeAId).listingVariant.findUniqueOrThrow({ where: { id: typed.variantId } });
    expect(typedRow.weightG).toBe(100);
    expect(typedRow.weightPlaceholder).toBe(false);
    expect(typedRow.price).toBe(800);
  });

  it("saving a weight on a placeholder listing that is in a cart succeeds", async () => {
    const row = await importPlaceholder(`Carted ${RUN}`);
    const cartId = await getOrCreateCart(storeAId, null, null);
    await addLine(storeAId, cartId, row.variantId, 1);
    asStore(storeASlug, ownerCookies);
    const result = await updateListingAction(saveForm(row.listingId, `Carted ${RUN}`, [
      { id: row.variantId, label: row.label, price: 800, weightG: 907 },
    ]));
    expect(result).toEqual({ success: true, id: row.listingId });
    const saved = await storeScoped(storeAId).listingVariant.findUniqueOrThrow({ where: { id: row.variantId } });
    expect(saved.id).toBe(row.variantId);
    expect(saved.weightG).toBe(907);
    expect(saved.weightPlaceholder).toBe(false);
    expect(saved.price).toBe(800);
    const cart = await getCartWithLines(storeAId, cartId);
    expect(cart?.lines).toHaveLength(1);
    expect(cart?.lines[0]?.variantId).toBe(row.variantId);
    expect(cart?.lines[0]?.qty).toBe(1);
  });

  it("saving with an empty weight is rejected and the row is unchanged", async () => {
    const row = await importPlaceholder(`Empty ${RUN}`);
    asStore(storeASlug, ownerCookies);
    const result = await updateListingAction(saveForm(row.listingId, `Empty ${RUN}`, [
      { id: row.variantId, label: row.label, price: 800, weightG: 0 },
    ]));
    expect(result).toEqual({ error: "Variant 1: weight must be greater than 0" });
    const saved = await storeScoped(storeAId).listingVariant.findUniqueOrThrow({ where: { id: row.variantId } });
    expect(saved.weightG).toBe(100);
    expect(saved.weightPlaceholder).toBe(true);
    expect(saved.price).toBe(800);
    const listing = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: row.listingId } });
    expect(listing.price).toBe(800);
  });

  it("a blank label on the only variant is rejected and the row is unchanged", async () => {
    const row = await importPlaceholder(`Blank Label ${RUN}`);
    asStore(storeASlug, ownerCookies);
    const fd = saveForm(row.listingId, `Blank Label ${RUN}`, []);
    fd.set("variants", serializeVariants([
      { id: row.variantId, label: "   ", price: "8.00", weightG: "" },
    ]));
    const result = await updateListingAction(fd);
    expect(result).toEqual({ error: "At least one variant is required" });
    const saved = await storeScoped(storeAId).listingVariant.findUniqueOrThrow({ where: { id: row.variantId } });
    expect(saved.weightG).toBe(100);
    expect(saved.weightPlaceholder).toBe(true);
    expect(saved.label).toBe(row.label);
  });

  it("a forged weightPlaceholder in the variants JSON is stored false", async () => {
    asStore(storeASlug, ownerCookies);
    const fd = new FormData();
    fd.set("customName", `Forged Create ${RUN}`);
    fd.set("price", "650");
    fd.set("stockMode", "counted");
    fd.set("qty", "2");
    fd.set("frozen", "false");
    fd.set("perishable", "false");
    fd.set("variants", JSON.stringify([
      { label: "Bag", price: 650, weightG: 500, weightPlaceholder: true },
    ]));
    const created = await createListingAction(fd);
    expect(created).toEqual({ success: true, id: expect.any(String) });
    const listingId = (created as { id: string }).id;
    const createdRow = await storeScoped(storeAId).listingVariant.findFirstOrThrow({
      where: { listingId },
    });
    expect(createdRow.weightPlaceholder).toBe(false);
    expect(createdRow.weightG).toBe(500);
    expect(createdRow.price).toBe(650);

    const updated = await updateListingAction(saveForm(listingId, `Forged Create ${RUN}`, [
      { id: createdRow.id, label: "Bag", price: 650, weightG: 500, weightPlaceholder: true },
    ], 650));
    expect(updated).toEqual({ success: true, id: listingId });
    const updatedRow = await storeScoped(storeAId).listingVariant.findUniqueOrThrow({
      where: { id: createdRow.id },
    });
    expect(updatedRow.id).toBe(createdRow.id);
    expect(updatedRow.weightPlaceholder).toBe(false);
    expect(updatedRow.weightG).toBe(500);
    expect(updatedRow.price).toBe(650);
  });

  it("a store B owner cannot save store A's listing", async () => {
    const row = await importPlaceholder(`Cross ${RUN}`);
    asStore(storeBSlug, otherCookies);
    const result = await updateListingAction(saveForm(row.listingId, `Cross ${RUN}`, [
      { id: row.variantId, label: row.label, price: 111, weightG: 200 },
    ], 111));
    expect(result).toEqual({ error: "Listing not found" });
    const saved = await storeScoped(storeAId).listingVariant.findUniqueOrThrow({ where: { id: row.variantId } });
    expect(saved.weightG).toBe(100);
    expect(saved.weightPlaceholder).toBe(true);
    expect(saved.price).toBe(800);
    const listing = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: row.listingId } });
    expect(listing.price).toBe(800);
  });

  it("a session without a verified second factor is redirected and changes nothing", async () => {
    const row = await importPlaceholder(`Half ${RUN}`);
    const signedIn = await authPost("/sign-in/email", { email: ownerEmail, password });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const body = await signedIn.json();
    expect(body.twoFactorRedirect).toBe(true);
    asStore(storeASlug, collectCookies(signedIn));
    await expect(updateListingAction(saveForm(row.listingId, `Half ${RUN}`, [
      { id: row.variantId, label: row.label, price: 222, weightG: 300 },
    ], 222))).rejects.toThrow(`REDIRECT:/store-admin/sign-in?store=${storeASlug}`);
    const saved = await storeScoped(storeAId).listingVariant.findUniqueOrThrow({ where: { id: row.variantId } });
    expect(saved.weightG).toBe(100);
    expect(saved.weightPlaceholder).toBe(true);
    expect(saved.price).toBe(800);
    const listing = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: row.listingId } });
    expect(listing.price).toBe(800);
  });
});
