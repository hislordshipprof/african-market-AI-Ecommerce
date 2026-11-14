import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

vi.mock("next/headers", () => ({ headers: async () => headerState }));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
  revalidatePath: () => {},
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { generateTOTP } from "../../../e2e/totp";
import { auth } from "../auth";
import { authPrisma, storeScoped, storeScopedTransaction } from "../db";
import { createCouponAction, setCouponActiveAction, updateCouponAction } from "./actions";
import { listCoupons } from "./service";

const BASE = "http://localhost:3000/api/auth";
const RUN = `t556-${Date.now()}`;
const password = "Coupon-556-Owner!";
const hasDb = !!process.env.DATABASE_URL;

function cookiesOf(res: Response, prior = ""): string {
  const jar = new Map<string, string>();
  for (const pair of prior.split("; ").filter(Boolean)) {
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0].trim();
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function authPost(path: string, body: unknown, cookies?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies) headers.cookie = cookies;
  return auth.handler(new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function signIn(email: string, twoFactor: boolean): Promise<string> {
  const signedIn = await authPost("/sign-in/email", { email, password });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  let cookies = cookiesOf(signedIn);
  if (!twoFactor) return cookies;
  const enabled = await authPost("/two-factor/enable", { password }, cookies);
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  cookies = cookiesOf(enabled, cookies);
  const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret");
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret!) }, cookies);
  expect(verified.status, await verified.clone().text()).toBe(200);
  return cookiesOf(verified, cookies);
}

function as(slug: string, cookies: string | null): void {
  if (cookies) headerState.set("cookie", cookies);
  else headerState.delete("cookie");
  headerState.set("x-store-slug", slug);
}

function couponForm(fields: Record<string, string>): FormData {
  const data = new FormData();
  const base = { code: "SAVE10", kind: "percent", percentOff: "10", startsAt: "2026-12-01T09:00", totalUses: "50", usesPerCustomer: "1" };
  for (const [k, v] of Object.entries({ ...base, ...fields })) data.set(k, v);
  return data;
}

describe.skipIf(!hasDb)("store coupons (real auth, lane database)", () => {
  const storeA = crypto.randomUUID();
  const storeB = crypto.randomUUID();
  const slugA = `cpa-${RUN}`;
  const slugB = `cpb-${RUN}`;
  const emails = { ownerA: `owner-a-${RUN}@example.com`, ownerB: `owner-b-${RUN}@example.com`, staff: `staff-${RUN}@example.com`, shopper: `shopper-${RUN}@example.com` };
  const ids: Record<keyof typeof emails, string> = { ownerA: "", ownerB: "", staff: "", shopper: "" };
  const cookies: Record<keyof typeof emails, string> = { ownerA: "", ownerB: "", staff: "", shopper: "" };
  let customerA = "";

  async function couponId(storeId: string, code: string): Promise<string> {
    return (await storeScoped(storeId).storeCoupon.findFirstOrThrow({ where: { code } })).id;
  }

  async function audit(storeId: string, entityId: string) {
    return storeScoped(storeId).auditLog.findMany({ where: { entityType: "store_coupon", entityId }, orderBy: { createdAt: "asc" } });
  }

  beforeAll(async () => {
    for (const key of Object.keys(emails) as Array<keyof typeof emails>) {
      const res = await authPost("/sign-up/email", { email: emails[key], password, name: key });
      expect(res.status, await res.clone().text()).toBe(200);
      ids[key] = (await authPrisma.user.findFirstOrThrow({ where: { email: emails[key] } })).id;
    }
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, timezone, updated_at) VALUES (${storeA}, 'Coupon A', ${slugA}, 'active', 'America/Chicago', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeB}, 'Coupon B', ${slugB}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeA}, ${ids.ownerA}, 'owner', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeB}, ${ids.ownerB}, 'owner', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeA}, ${ids.staff}, 'staff', now())`;
    });
    customerA = (await storeScoped(storeA).customer.create({ data: { storeId: storeA, name: "Shopper", userId: ids.shopper } })).id;
    cookies.ownerA = await signIn(emails.ownerA, true);
    cookies.ownerB = await signIn(emails.ownerB, true);
    cookies.staff = await signIn(emails.staff, true);
    cookies.shopper = await signIn(emails.shopper, false);
  }, 90_000);

  afterAll(async () => {
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM orders WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM customers WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM store_coupons WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${storeA}, ${storeB})`;
      const userIds = Object.values(ids);
      for (const userId of userIds) {
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id = ${userId}`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${userId}`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id = ${userId}`;
        await tx.$executeRaw`DELETE FROM users WHERE id = ${userId}`;
      }
    });
  });

  it("the owner creates a code, stored upper-case, with start in store time, and audited", async () => {
    as(slugA, cookies.ownerA);
    const result = await createCouponAction(couponForm({ code: "save10" }));
    expect(result).toEqual({ ok: true });
    const [coupon] = await listCoupons(storeA);
    expect(coupon).toMatchObject({ code: "SAVE10", kind: "percent", percentOff: 10, totalUses: 50, usesPerCustomer: 1, active: true, usesSoFar: 0, discountGivenCents: 0 });
    expect(coupon.startsAt).toEqual(new Date("2026-12-01T15:00:00Z"));
    const log = await audit(storeA, coupon.id);
    expect(log.map((l) => [l.action, l.actorId])).toEqual([["coupon.create", ids.ownerA]]);
  });

  it("a code is unique per store whatever the case, and the same code at another store is independent", async () => {
    as(slugA, cookies.ownerA);
    expect(await createCouponAction(couponForm({ code: "Save10" }))).toEqual({ ok: false, error: "Your store already has the code SAVE10." });
    as(slugB, cookies.ownerB);
    expect(await createCouponAction(couponForm({ code: "SAVE10", kind: "fixed", amountOff: "5" }))).toEqual({ ok: true });
    const [atB] = await listCoupons(storeB);
    const [atA] = await listCoupons(storeA);
    expect(atB.id).not.toBe(atA.id);
    expect([atA.kind, atB.kind]).toEqual(["percent", "fixed"]);
    expect(atB.amountOffCents).toBe(500);
  });

  it("a cross-store read or write fails", async () => {
    const idA = await couponId(storeA, "SAVE10");
    expect(await storeScoped(storeB).storeCoupon.findUnique({ where: { id: idA } })).toBeNull();
    expect((await storeScoped(storeB).storeCoupon.updateMany({ where: { id: idA }, data: { active: false } })).count).toBe(0);
    await expect(storeScoped(storeB).storeCoupon.create({
      data: { storeId: storeA, code: "SNEAK", kind: "percent", percentOff: 50, startsAt: new Date(), createdById: ids.ownerB },
    })).rejects.toThrow();

    as(slugB, cookies.ownerB);
    expect(await setCouponActiveAction(idA, false)).toEqual({ ok: false, error: "Coupon not found." });
    expect(await updateCouponAction(idA, couponForm({ code: "SAVE10", percentOff: "90" }))).toEqual({ ok: false, error: "Coupon not found." });
    const [stillA] = await listCoupons(storeA);
    expect([stillA.active, stillA.percentOff]).toEqual([true, 10]);
  });

  it("an order cannot point at another store's coupon", async () => {
    const idA = await couponId(storeA, "SAVE10");
    const customerB = await storeScoped(storeB).customer.create({ data: { storeId: storeB, name: "B shopper" } });
    await expect(storeScoped(storeB).order.create({
      data: { storeId: storeB, number: 1, customerId: customerB.id, subtotalCents: 1000, bufferCents: 0, totalAuthorizedCents: 900, couponId: idA, discountCents: 100 },
    })).rejects.toThrow();
  });

  it("the list shows uses so far and discount given from orders, not counting cancelled orders", async () => {
    const idA = await couponId(storeA, "SAVE10");
    const order = (number: number, status: string, discountCents: number) => storeScoped(storeA).order.create({
      data: { storeId: storeA, number, customerId: customerA, status, subtotalCents: 4000, bufferCents: 0, totalAuthorizedCents: 4000 - discountCents, couponId: idA, discountCents },
    });
    await order(1, "COMPLETED", 400);
    await order(2, "AUTHORIZED", 250);
    await order(3, "CANCELLED", 300);
    await storeScoped(storeA).order.create({
      data: { storeId: storeA, number: 4, customerId: customerA, subtotalCents: 4000, bufferCents: 0, totalAuthorizedCents: 4000 },
    });
    const coupon = (await listCoupons(storeA)).find((c) => c.id === idA);
    expect([coupon?.usesSoFar, coupon?.discountGivenCents]).toEqual([2, 650]);
  });

  it("a used code cannot change its type or value, but other edits are saved and audited", async () => {
    const idA = await couponId(storeA, "SAVE10");
    as(slugA, cookies.ownerA);
    const locked = "This code has been used, so its type and value cannot change. Deactivate it and create a new one.";
    expect(await updateCouponAction(idA, couponForm({ percentOff: "20" }))).toEqual({ ok: false, error: locked });
    expect(await updateCouponAction(idA, couponForm({ kind: "fixed", percentOff: "", amountOff: "10" }))).toEqual({ ok: false, error: locked });

    expect(await updateCouponAction(idA, couponForm({ endsAt: "2026-12-31T23:59", totalUses: "80" }))).toEqual({ ok: true });
    const [coupon] = (await listCoupons(storeA)).filter((c) => c.id === idA);
    expect([coupon.percentOff, coupon.totalUses, coupon.endsAt]).toEqual([10, 80, new Date("2027-01-01T05:59:00Z")]);
    const update = (await audit(storeA, idA)).find((l) => l.action === "coupon.update");
    expect(update?.before).toMatchObject({ totalUses: 50, endsAt: null });
    expect(update?.after).toMatchObject({ totalUses: 80, endsAt: "2027-01-01T05:59:00.000Z" });
  });

  it("an unused code can change its value", async () => {
    as(slugB, cookies.ownerB);
    const idB = await couponId(storeB, "SAVE10");
    expect(await updateCouponAction(idB, couponForm({ kind: "fixed", amountOff: "7.50" }))).toEqual({ ok: true });
    expect((await listCoupons(storeB))[0].amountOffCents).toBe(750);
  });

  it("deactivate is audited", async () => {
    const idA = await couponId(storeA, "SAVE10");
    as(slugA, cookies.ownerA);
    expect(await setCouponActiveAction(idA, false)).toEqual({ ok: true });
    expect((await listCoupons(storeA))[0].active).toBe(false);
    const log = (await audit(storeA, idA)).find((l) => l.action === "coupon.deactivate");
    expect([log?.before, log?.after]).toEqual([{ active: true }, { active: false }]);
  });

  it("staff, a signed-in shopper and a guest are refused with no write", async () => {
    const idA = await couponId(storeA, "SAVE10");
    const before = await storeScopedTransaction(storeA, (tx) => tx.storeCoupon.count());
    for (const who of [cookies.staff, cookies.shopper, null]) {
      as(slugA, who);
      await expect(createCouponAction(couponForm({ code: "STAFF5" }))).rejects.toThrow(/REDIRECT:/);
      await expect(updateCouponAction(idA, couponForm({ percentOff: "90" }))).rejects.toThrow(/REDIRECT:/);
      await expect(setCouponActiveAction(idA, true)).rejects.toThrow(/REDIRECT:/);
    }
    expect(await storeScopedTransaction(storeA, (tx) => tx.storeCoupon.count())).toBe(before);
    expect((await listCoupons(storeA))[0].active).toBe(false);
  });
});
