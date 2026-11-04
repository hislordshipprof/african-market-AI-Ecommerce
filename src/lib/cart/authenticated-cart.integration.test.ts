import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState, cartCookies } = vi.hoisted(() => ({
  headerState: new Headers(),
  cartCookies: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  headers: async () => headerState,
  cookies: async () => ({
    get: (name: string) => {
      const value = cartCookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      cartCookies.set(name, value);
    },
  }),
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { auth } from "../auth";
import { authPrisma, storeScoped } from "../db";
import { addToCart, clearCart, getServerCart } from "./actions";
import { quoteCheckoutAction } from "../checkout/actions";

const hasDb = !!process.env.DATABASE_URL;
const BASE = "http://localhost:3000/api/auth";
const RUN = `cart-auth-${Date.now().toString(36)}`;
const password = "CartLink-123!";

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

function asStore(slug: string, cookies?: string) {
  if (cookies) headerState.set("cookie", cookies);
  else headerState.delete("cookie");
  headerState.set("x-store-slug", slug);
}

describe.skipIf(!hasDb)("authenticated cart actions (real session, lane DB)", () => {
  const email = `ada-${RUN}@example.com`;
  const otherEmail = `other-${RUN}@example.com`;
  const storeSlug = `cart-auth-${RUN}`;
  const storeBSlug = `cart-auth-b-${RUN}`;
  let storeId = "";
  let storeBId = "";
  let userId = "";
  let otherId = "";
  let variantId = "";
  let variantBId = "";
  let sessionCookies = "";

  beforeAll(async () => {
    const signedUp = await authPost("/sign-up/email", {
      email,
      password,
      name: "Ada Buyer",
    });
    expect(signedUp.status, await signedUp.clone().text()).toBe(200);
    const signedIn = await authPost("/sign-in/email", { email, password });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    sessionCookies = collectCookies(signedIn);
    expect(sessionCookies).toContain("session_token");

    const user = await authPrisma.user.findFirstOrThrow({ where: { email } });
    userId = user.id;
    otherId = `other-${RUN}`;
    await authPrisma.user.create({
      data: { id: otherId, name: "Other Buyer", email: otherEmail },
    });
    storeId = crypto.randomUUID();
    storeBId = crypto.randomUUID();
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, ${"Cart Auth " + RUN}, ${storeSlug}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeBId}, ${"Cart Auth B " + RUN}, ${storeBSlug}, 'active', now())`;
    });

    const listing = await storeScoped(storeId).listing.create({
      data: {
        storeId,
        customName: "Egusi",
        price: 1200,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "500g", price: 1200, weightG: 500 },
    });
    variantId = variant.id;

    const listingB = await storeScoped(storeBId).listing.create({
      data: {
        storeId: storeBId,
        customName: "Egusi",
        price: 900,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const variantB = await storeScoped(storeBId).listingVariant.create({
      data: { listingId: listingB.id, label: "250g", price: 900, weightG: 250 },
    });
    variantBId = variantB.id;
  }, 30_000);

  afterAll(async () => {
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM cart_lines WHERE store_id IN (${storeId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM carts WHERE store_id IN (${storeId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM customers WHERE store_id IN (${storeId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM listing_variants WHERE listing_id IN (SELECT id FROM listings WHERE store_id IN (${storeId}, ${storeBId}))`;
      await tx.$executeRaw`DELETE FROM listings WHERE store_id IN (${storeId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${userId}`;
      await tx.$executeRaw`DELETE FROM accounts WHERE user_id = ${userId}`;
      await tx.$executeRaw`DELETE FROM verifications WHERE value LIKE ${"%" + email + "%"}`;
      await tx.$executeRaw`DELETE FROM users WHERE id IN (${userId}, ${otherId})`;
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${storeId}, ${storeBId})`;
    });
  }, 30_000);

  beforeEach(() => {
    cartCookies.clear();
    headerState.delete("cookie");
    headerState.delete("x-store-slug");
  });

  async function wipeCarts() {
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM cart_lines WHERE store_id IN (${storeId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM carts WHERE store_id IN (${storeId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM customers WHERE store_id IN (${storeId}, ${storeBId})`;
    });
  }

  it("sets the session account and Customer when a signed-in shopper adds to the cart", async () => {
    await wipeCarts();
    asStore(storeSlug, sessionCookies);
    const result = await addToCart(variantId, 1);
    expect(result).toEqual({ ok: true });

    const carts = await storeScoped(storeId).cart.findMany();
    expect(carts).toHaveLength(1);
    expect(carts[0].userId).toBe(userId);
    expect(carts[0].customerId).toEqual(expect.any(String));

    const customer = await storeScoped(storeId).customer.findUnique({
      where: { id: carts[0].customerId! },
    });
    expect(customer).toMatchObject({
      userId,
      storeId,
      name: "Ada Buyer",
      email,
      marketingConsent: false,
    });
    expect(cartCookies.get("cart_id")).toBe(carts[0].id);
  });

  it("leaves the cart unlinked when nobody is signed in", async () => {
    await wipeCarts();
    asStore(storeSlug);
    const result = await addToCart(variantId, 1);
    expect(result).toEqual({ ok: true });
    const carts = await storeScoped(storeId).cart.findMany();
    expect(carts).toHaveLength(1);
    expect(carts[0].userId).toBeNull();
    expect(carts[0].customerId).toBeNull();
    const customers = await storeScoped(storeId).customer.findMany();
    expect(customers).toHaveLength(0);
  });

  it("links the guest cart, and its lines, after the shopper signs in", async () => {
    await wipeCarts();
    asStore(storeSlug);
    expect(await addToCart(variantId, 1)).toEqual({ ok: true });
    const guestCartId = cartCookies.get("cart_id");
    expect(guestCartId).toEqual(expect.any(String));

    asStore(storeSlug, sessionCookies);
    expect(await addToCart(variantId, 1)).toEqual({ ok: true });
    expect(cartCookies.get("cart_id")).toBe(guestCartId);

    const cart = await storeScoped(storeId).cart.findUnique({ where: { id: guestCartId } });
    expect(cart?.userId).toBe(userId);
    expect(cart?.customerId).toEqual(expect.any(String));
    const lines = await storeScoped(storeId).cartLine.findMany({ where: { cartId: guestCartId! } });
    expect(lines).toHaveLength(1);
    expect(lines[0].qty).toBe(2);
    const customers = await storeScoped(storeId).customer.findMany();
    expect(customers).toHaveLength(1);
  });

  it("keeps one Customer when the signed-in shopper adds twice", async () => {
    await wipeCarts();
    asStore(storeSlug, sessionCookies);
    expect(await addToCart(variantId, 1)).toEqual({ ok: true });
    expect(await addToCart(variantId, 1)).toEqual({ ok: true });
    const customers = await storeScoped(storeId).customer.findMany({ where: { userId } });
    expect(customers).toHaveLength(1);
    const carts = await storeScoped(storeId).cart.findMany();
    expect(carts).toHaveLength(1);
    expect(carts[0].customerId).toBe(customers[0].id);
  });

  it("opens a separate Customer at a second store and hides the first", async () => {
    await wipeCarts();
    asStore(storeSlug, sessionCookies);
    expect(await addToCart(variantId, 1)).toEqual({ ok: true });
    const here = await storeScoped(storeId).customer.findMany({ where: { userId } });
    expect(here).toHaveLength(1);

    cartCookies.clear();
    asStore(storeBSlug, sessionCookies);
    expect(await addToCart(variantBId, 1)).toEqual({ ok: true });
    const there = await storeScoped(storeBId).customer.findMany({ where: { userId } });
    expect(there).toHaveLength(1);
    expect(there[0].id).not.toBe(here[0].id);
    const hidden = await storeScoped(storeId).customer.findMany({ where: { id: there[0].id } });
    expect(hidden).toHaveLength(0);
  });

  it("does not take a cart that already belongs to another account", async () => {
    await wipeCarts();
    const theirs = await storeScoped(storeId).cart.create({
      data: { storeId, userId: otherId, source: "manual" },
    });
    cartCookies.set("cart_id", theirs.id);
    asStore(storeSlug, sessionCookies);
    expect(await addToCart(variantId, 1)).toEqual({ ok: true });

    const otherCart = await storeScoped(storeId).cart.findUnique({ where: { id: theirs.id } });
    expect(otherCart?.userId).toBe(otherId);
    expect(otherCart?.customerId).toBeNull();
    const mineId = cartCookies.get("cart_id");
    expect(mineId).not.toBe(theirs.id);
    const mine = await storeScoped(storeId).cart.findUnique({ where: { id: mineId } });
    expect(mine?.userId).toBe(userId);
    expect(mine?.customerId).toEqual(expect.any(String));
  });

  it("opens a fresh unlinked cart after sign-out and leaves the account cart", async () => {
    await wipeCarts();
    asStore(storeSlug, sessionCookies);
    expect(await addToCart(variantId, 1)).toEqual({ ok: true });
    const accountCartId = cartCookies.get("cart_id");
    expect(accountCartId).toEqual(expect.any(String));

    asStore(storeSlug);
    expect(await addToCart(variantId, 1)).toEqual({ ok: true });
    const guestCartId = cartCookies.get("cart_id");
    expect(guestCartId).not.toBe(accountCartId);

    const accountCart = await storeScoped(storeId).cart.findUnique({ where: { id: accountCartId } });
    expect(accountCart?.userId).toBe(userId);
    expect(accountCart?.customerId).toEqual(expect.any(String));
    const accountLines = await storeScoped(storeId).cartLine.findMany({
      where: { cartId: accountCartId },
    });
    expect(accountLines).toHaveLength(1);
    expect(accountLines[0].qty).toBe(1);

    const guestCart = await storeScoped(storeId).cart.findUnique({ where: { id: guestCartId } });
    expect(guestCart?.userId).toBeNull();
    expect(guestCart?.customerId).toBeNull();
    const guestLines = await storeScoped(storeId).cartLine.findMany({
      where: { cartId: guestCartId },
    });
    expect(guestLines).toHaveLength(1);
    expect(guestLines[0].qty).toBe(1);
    const customers = await storeScoped(storeId).customer.findMany();
    expect(customers).toHaveLength(1);
  });

  it("shows an empty unlinked cart after sign-out and leaves the account lines", async () => {
    await wipeCarts();
    asStore(storeSlug, sessionCookies);
    expect(await addToCart(variantId, 1)).toEqual({ ok: true });
    const accountCartId = cartCookies.get("cart_id");
    expect(accountCartId).toEqual(expect.any(String));

    asStore(storeSlug);
    const shown = await getServerCart();
    expect(shown?.id).not.toBe(accountCartId);
    expect(shown?.lines).toHaveLength(0);
    expect(cartCookies.get("cart_id")).toBe(shown?.id);

    const accountCart = await storeScoped(storeId).cart.findUnique({ where: { id: accountCartId } });
    expect(accountCart?.userId).toBe(userId);
    expect(accountCart?.customerId).toEqual(expect.any(String));
    const accountLines = await storeScoped(storeId).cartLine.findMany({
      where: { cartId: accountCartId },
    });
    expect(accountLines).toHaveLength(1);
    expect(accountLines[0].qty).toBe(1);

    const guest = await storeScoped(storeId).cart.findUnique({ where: { id: shown!.id } });
    expect(guest?.userId).toBeNull();
    expect(guest?.customerId).toBeNull();
    const customers = await storeScoped(storeId).customer.findMany();
    expect(customers).toHaveLength(1);
  });

  it("does not clear an account cart when a signed-out shopper clears the basket", async () => {
    await wipeCarts();
    asStore(storeSlug, sessionCookies);
    expect(await addToCart(variantId, 1)).toEqual({ ok: true });
    const accountCartId = cartCookies.get("cart_id");

    asStore(storeSlug);
    expect(await clearCart()).toEqual({ ok: true });

    const accountLines = await storeScoped(storeId).cartLine.findMany({
      where: { cartId: accountCartId },
    });
    expect(accountLines).toHaveLength(1);
    expect(accountLines[0].qty).toBe(1);
    expect(cartCookies.get("cart_id")).not.toBe(accountCartId);
  });

  it("quotes an empty cart after sign-out instead of the account basket", async () => {
    await wipeCarts();
    asStore(storeSlug, sessionCookies);
    expect(await addToCart(variantId, 1)).toEqual({ ok: true });
    const accountCartId = cartCookies.get("cart_id");

    asStore(storeSlug);
    const quote = await quoteCheckoutAction(
      { name: "Ada Buyer", email, phone: "2025550100" },
      "pickup",
    );
    expect(quote.ok).toBe(true);
    if (quote.ok) expect(quote.quote.subtotalCents).toBe(0);

    const accountLines = await storeScoped(storeId).cartLine.findMany({
      where: { cartId: accountCartId },
    });
    expect(accountLines).toHaveLength(1);
    expect(accountLines[0].qty).toBe(1);
    expect(cartCookies.get("cart_id")).not.toBe(accountCartId);
  });

  it("does not show another account's lines to a signed-in shopper", async () => {
    await wipeCarts();
    const theirs = await storeScoped(storeId).cart.create({
      data: { storeId, userId: otherId, source: "manual" },
    });
    await storeScoped(storeId).cartLine.create({
      data: {
        storeId,
        cartId: theirs.id,
        variantId,
        qty: 1,
        swapRule: "exact_only",
      },
    });
    cartCookies.set("cart_id", theirs.id);
    asStore(storeSlug, sessionCookies);

    const shown = await getServerCart();
    expect(shown?.id).not.toBe(theirs.id);
    expect(shown?.lines ?? []).toHaveLength(0);
    const lines = await storeScoped(storeId).cartLine.findMany({ where: { cartId: theirs.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0].qty).toBe(1);
    const otherCart = await storeScoped(storeId).cart.findUnique({ where: { id: theirs.id } });
    expect(otherCart?.userId).toBe(otherId);
  });
});
