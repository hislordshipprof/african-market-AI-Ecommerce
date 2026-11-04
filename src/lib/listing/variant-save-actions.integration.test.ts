import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

import { generateTOTP } from "../../../e2e/totp";

const { headerState, revalidated } = vi.hoisted(() => ({
  headerState: new Headers(),
  revalidated: [] as unknown[][],
}));

vi.mock("next/headers", () => ({
  headers: async () => headerState,
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: (...args: unknown[]) => {
    revalidated.push(args);
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

import { auth } from "../auth";
import { authPrisma, storeScoped } from "../db";
import { createListing } from "./service";
import { updateListingAction } from "./actions";
import { storefrontTag } from "../storefront/cache";

const hasDb = !!process.env.DATABASE_URL;
const BASE = "http://localhost:3000/api/auth";
const RUN = `v221-act-${Date.now().toString(36)}`;
const password = "VariantSave-123!";

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

/** Enable TOTP on a fresh password session, confirm it, then sign that session out. */
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

/** Password sign-in after enrollment. The first response is only the challenge. */
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
  fd.set("qty", "10");
  fd.set("frozen", "false");
  fd.set("perishable", "false");
  fd.set("maxPerOrder", "");
  fd.set("masterProductId", "");
  fd.set("variants", JSON.stringify(variants));
  return fd;
}

describe.skipIf(!hasDb)("listing save actions (real auth, lane DB)", () => {
  const ownerEmail = `owner-${RUN}@example.com`;
  const staffEmail = `staff-${RUN}@example.com`;
  const otherEmail = `other-${RUN}@example.com`;
  const storeASlug = `v221-a-${RUN}`;
  const storeBSlug = `v221-b-${RUN}`;
  let storeAId = "";
  let storeBId = "";
  let ownerId = "";
  let ownerSecret = "";
  let ownerCookies = "";
  let staffCookies = "";
  let otherCookies = "";
  let listingId = "";
  let variantId = "";
  let listingName = "";

  beforeAll(async () => {
    await signUp(ownerEmail, "Variant Owner");
    await signUp(staffEmail, "Variant Staff");
    await signUp(otherEmail, "Variant Other");
    const owner = await authPrisma.user.findFirstOrThrow({ where: { email: ownerEmail } });
    const staff = await authPrisma.user.findFirstOrThrow({ where: { email: staffEmail } });
    const other = await authPrisma.user.findFirstOrThrow({ where: { email: otherEmail } });
    ownerId = owner.id;
    storeAId = crypto.randomUUID();
    storeBId = crypto.randomUUID();

    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeAId}, ${"Save A " + RUN}, ${storeASlug}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeBId}, ${"Save B " + RUN}, ${storeBSlug}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeAId}, ${owner.id}, 'owner', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeAId}, ${staff.id}, 'staff', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeBId}, ${other.id}, 'owner', now())`;
    });

    const ownerSecretEnrolled = await enrollTotp(ownerEmail);
    ownerSecret = ownerSecretEnrolled;
    const staffSecret = await enrollTotp(staffEmail);
    const otherSecret = await enrollTotp(otherEmail);
    await waitForNextTotpWindow();

    staffCookies = (await challengedSession(staffEmail, staffSecret)).verified;
    otherCookies = (await challengedSession(otherEmail, otherSecret)).verified;

    listingName = `Carted ${RUN}`;
    const created = await createListing({
      storeId: storeAId,
      customName: listingName,
      price: 800,
      stockMode: "counted",
      qty: 10,
      frozen: false,
      perishable: false,
      variants: [{ label: "1kg", price: 800, weightG: 1000 }],
      actor: { id: ownerId, email: ownerEmail },
    });
    listingId = created.id;
    variantId = created.variants[0]!.id;
    const cart = await storeScoped(storeAId).cart.create({ data: { storeId: storeAId } });
    await storeScoped(storeAId).cartLine.create({
      data: { storeId: storeAId, cartId: cart.id, variantId, qty: 1 },
    });
  }, 90_000);

  afterAll(async () => {
    const emails = [ownerEmail, staffEmail, otherEmail];
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM cart_lines WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM carts WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM listing_variants WHERE listing_id IN (SELECT id FROM listings WHERE store_id IN (${storeAId}, ${storeBId}))`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM stock_events WHERE store_id IN (${storeAId}, ${storeBId})`;
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
  });

  async function variantPrice(): Promise<number> {
    const row = await storeScoped(storeAId).listingVariant.findUniqueOrThrow({ where: { id: variantId } });
    return row.price;
  }

  it("an anonymous caller is redirected before the listing changes", async () => {
    asStore(storeASlug, "");
    await expect(updateListingAction(saveForm(listingId, listingName, [
      { id: variantId, label: "1kg", price: 111, weightG: 1000 },
    ]))).rejects.toThrow(`REDIRECT:/store-admin/sign-in?store=${storeASlug}`);
    expect(await variantPrice()).toBe(800);
    expect(revalidated).toEqual([]);
  });

  it("a staff member is redirected before the listing changes", async () => {
    asStore(storeASlug, staffCookies);
    await expect(updateListingAction(saveForm(listingId, listingName, [
      { id: variantId, label: "1kg", price: 333, weightG: 1000 },
    ]))).rejects.toThrow(`REDIRECT:/store-admin?store=${storeASlug}`);
    expect(await variantPrice()).toBe(800);
    expect(revalidated).toEqual([]);
  });

  it("store B's owner cannot save store A's listing and nothing is revalidated", async () => {
    asStore(storeBSlug, otherCookies);
    const result = await updateListingAction(saveForm(listingId, listingName, [
      { id: variantId, label: "1kg", price: 444, weightG: 1000 },
    ]));
    expect(result).toEqual({ error: "Listing not found" });
    expect(await variantPrice()).toBe(800);
    expect(revalidated).toEqual([]);
  });

  it("a live TOTP challenge is denied, then the same challenge saves the carted variant", async () => {
    const signedIn = await authPost("/sign-in/email", { email: ownerEmail, password });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const body = await signedIn.json();
    expect(body.twoFactorRedirect).toBe(true);
    const pending = collectCookies(signedIn);
    const before = {
      listing: await storeScoped(storeAId).listing.findUniqueOrThrow({
        where: { id: listingId },
        include: { variants: { orderBy: { id: "asc" } } },
      }),
      events: await storeScoped(storeAId).stockEvent.findMany({ where: { listingId }, orderBy: { id: "asc" } }),
      audits: await storeScoped(storeAId).auditLog.findMany({ where: { entityId: listingId }, orderBy: { id: "asc" } }),
    };
    const revalidatedBefore = revalidated.length;
    asStore(storeASlug, pending);
    await expect(updateListingAction(saveForm(listingId, listingName, [
      { id: variantId, label: "1kg", price: 222, weightG: 1000 },
    ]))).rejects.toThrow(`REDIRECT:/store-admin/sign-in?store=${storeASlug}`);
    const after = {
      listing: await storeScoped(storeAId).listing.findUniqueOrThrow({
        where: { id: listingId },
        include: { variants: { orderBy: { id: "asc" } } },
      }),
      events: await storeScoped(storeAId).stockEvent.findMany({ where: { listingId }, orderBy: { id: "asc" } }),
      audits: await storeScoped(storeAId).auditLog.findMany({ where: { entityId: listingId }, orderBy: { id: "asc" } }),
    };
    expect(after).toEqual(before);
    expect(revalidated).toHaveLength(revalidatedBefore);

    const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(ownerSecret) }, pending);
    expect(verified.status, await verified.clone().text()).toBe(200);
    ownerCookies = collectCookies(verified) || pending;
    asStore(storeASlug, ownerCookies);
    const result = await updateListingAction(saveForm(listingId, listingName, [
      { id: variantId, label: "1kg", price: 950, weightG: 1200 },
    ]));
    expect(result).toEqual({ success: true, id: listingId });
    const row = await storeScoped(storeAId).listingVariant.findUniqueOrThrow({ where: { id: variantId } });
    expect(row).toMatchObject({ id: variantId, price: 950, weightG: 1200 });
    expect(revalidated).toEqual([[storefrontTag(storeAId), { expire: 0 }]]);
  });

  it("a refused removal returns the cart message and does not revalidate", async () => {
    asStore(storeASlug, ownerCookies);
    const before = revalidated.length;
    const result = await updateListingAction(saveForm(listingId, listingName, [
      { label: "new", price: 100, weightG: 100 },
    ]));
    expect(result).toEqual({
      error: `"1kg" is in a customer's cart or an order, so it can't be removed.`,
    });
    expect(await variantPrice()).toBe(950);
    expect(revalidated).toHaveLength(before);
  });
});
