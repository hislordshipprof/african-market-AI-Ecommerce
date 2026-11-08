import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateTOTP } from "../../../e2e/totp";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

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
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { createListingAction, deactivateListingAction, updateListingAction } from "../listing/actions";
import { acceptOrderAction, markLinePickedAction } from "../order/actions";
import { csvCommitAction } from "../listing/csv-import-actions";
import { inviteMemberAction, removeMemberAction } from "../store-admin/actions";
import { setStoreStatus } from "../admin/actions";
import { approveProduct } from "../admin/catalog-actions";
import { resolveRefundFailedAction } from "../admin/refund-resolution";
import { auth } from "../auth";
import { authPrisma, platformAdmin, storeScoped, storeScopedTransaction } from "../db";

const BASE = "http://localhost:3000/api/auth";
const suffix = `${Date.now()}-az`;
const password = "GuardPass-123!";
const emailA = `authz-a-${suffix}@test.example`;
const emailB = `authz-b-${suffix}@test.example`;
const slugA = `az-a-${suffix}`;
const slugB = `az-b-${suffix}`;

function collectCookies(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).join("; ");
}

async function authPost(path: string, body: unknown, cookies?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies) headers.cookie = cookies;
  return auth.handler(new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function signUp(email: string, name: string): Promise<string> {
  const res = await authPost("/sign-up/email", { email, password, name });
  expect(res.status, await res.clone().text()).toBe(200);
  const user = await authPrisma.user.findFirstOrThrow({ where: { email } });
  return user.id;
}

function asGuest(slug: string) {
  headerState.delete("cookie");
  headerState.set("x-store-slug", slug);
}

function asA(slug: string, cookies: string) {
  headerState.set("cookie", cookies);
  headerState.set("x-store-slug", slug);
}

function listingForm(price: string, variants: unknown[], listingId?: string): FormData {
  const data = new FormData();
  data.set("customName", "Authz yam");
  data.set("price", price);
  data.set("stockMode", "counted");
  data.set("qty", "1");
  data.set("variants", JSON.stringify(variants));
  if (listingId) data.set("listingId", listingId);
  return data;
}

const oneVariant = [{ label: "bag", price: 100, weightG: 500 }];

describe("action authorization", () => {
  let storeA = "";
  let storeB = "";
  let ownerA = "";
  let ownerB = "";
  let cookiesA = "";
  let listingId = "";
  let variantId = "";
  let orderId = "";
  let lineId = "";
  let importId = "";
  let inviteId = "";
  let productId = "";
  let refundId = "";

  beforeAll(async () => {
    ownerA = await signUp(emailA, "Authz A");
    ownerB = await signUp(emailB, "Authz B");
    const signedIn = await authPost("/sign-in/email", { email: emailA, password });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const cookies = collectCookies(signedIn);
    const enabled = await authPost("/two-factor/enable", { password }, cookies);
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret");
    if (!secret) throw new Error("TOTP URI has no secret");
    const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
    expect(verified.status, await verified.clone().text()).toBe(200);
    cookiesA = collectCookies(verified) || cookies;

    storeA = crypto.randomUUID();
    storeB = crypto.randomUUID();
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeA}, 'Authz A', ${slugA}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeB}, 'Authz B', ${slugB}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeA}, ${ownerA}, 'owner', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeB}, ${ownerB}, 'owner', now())`;
    });

    const product = await platformAdmin.masterProduct.create({
      data: { name: `Authz product ${suffix}`, status: "needs_review" },
    });
    productId = product.id;

    const listing = await storeScoped(storeB).listing.create({
      data: {
        storeId: storeB,
        customName: "B yam",
        price: 500,
        stockMode: "counted",
        qty: 3,
        active: true,
        masterProductId: productId,
      },
    });
    listingId = listing.id;
    const variant = await storeScoped(storeB).listingVariant.create({
      data: { listingId, label: "1kg", price: 500, weightG: 1000 },
    });
    variantId = variant.id;
    const customer = await storeScoped(storeB).customer.create({
      data: { storeId: storeB, name: "Authz buyer" },
    });
    const order = await storeScoped(storeB).order.create({
      data: {
        storeId: storeB,
        number: 30901,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 500,
        bufferCents: 0,
        totalAuthorizedCents: 500,
        totalCents: 500,
        paymentIntentId: `pi_authz_${suffix}`,
      },
    });
    orderId = order.id;
    const line = await storeScoped(storeB).orderLine.create({
      data: {
        storeId: storeB,
        orderId,
        listingVariantId: variantId,
        qtyOrdered: 1,
        unitPriceCents: 500,
      },
    });
    lineId = line.id;
    const refund = await storeScoped(storeB).refundRequest.create({
      data: {
        storeId: storeB,
        orderId,
        paymentIntentId: `pi_authz_${suffix}`,
        key: `refund:authz:${suffix}`,
        amountCents: 500,
        refundApplicationFee: false,
        state: "RESERVED",
      },
    });
    refundId = refund.id;
    const imported = await storeScoped(storeB).listingImport.create({
      data: {
        storeId: storeB,
        csvText: "name,price\nYam,5\n",
        rowCount: 1,
        status: "pending",
        createdById: ownerB,
      },
    });
    importId = imported.id;
    const invite = await storeScoped(storeB).storeInvite.create({
      data: {
        storeId: storeB,
        email: `kept-${suffix}@test.example`,
        role: "staff",
        tokenHash: `hash-${suffix}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedById: ownerB,
      },
    });
    inviteId = invite.id;
    await storeScoped(storeB).auditLog.create({
      data: {
        storeId: storeB,
        actorId: ownerB,
        actorEmail: emailB,
        action: "seed",
        entityType: "listing",
        entityId: listingId,
      },
    });
  }, 90_000);

  afterAll(async () => {
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM refund_requests WHERE store_id = ${storeB}`;
      await tx.$executeRaw`DELETE FROM order_lines WHERE store_id = ${storeB}`;
      await tx.$executeRaw`DELETE FROM orders WHERE store_id = ${storeB}`;
      await tx.$executeRaw`DELETE FROM customers WHERE store_id = ${storeB}`;
      await tx.$executeRaw`DELETE FROM stock_events WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM listing_variants WHERE listing_id IN (SELECT id FROM listings WHERE store_id IN (${storeA}, ${storeB}))`;
      await tx.$executeRaw`DELETE FROM listings WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM listing_imports WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM store_invites WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id IN (${storeA}, ${storeB}) OR actor_id IN (${ownerA}, ${ownerB})`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM master_products WHERE id = ${productId}`;
      for (const userId of [ownerA, ownerB]) {
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id = ${userId}`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${userId}`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id = ${userId}`;
      }
      await tx.$executeRaw`DELETE FROM verifications WHERE value LIKE ${"%" + emailA + "%"} OR value LIKE ${"%" + emailB + "%"}`;
      await tx.$executeRaw`DELETE FROM users WHERE id IN (${ownerA}, ${ownerB})`;
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${storeA}, ${storeB})`;
    });
  });

  async function storeStatus(storeId: string): Promise<string | undefined> {
    const rows = await storeScopedTransaction(storeId, (tx) =>
      tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM stores WHERE id = ${storeId}`,
    );
    return rows[0]?.status;
  }

  describe("listing", () => {
    it("guest is refused with no write", async () => {
      asGuest(slugB);
      await expect(deactivateListingAction(listingId)).rejects.toThrow(/REDIRECT:\/store-admin\/sign-in/);
      const row = await storeScoped(storeB).listing.findUnique({ where: { id: listingId } });
      expect(row?.active).toBe(true);
      expect(row?.price).toBe(500);
    });

    it("store A cannot touch store B listings", async () => {
      asA(slugA, cookiesA);
      const deactivated = await deactivateListingAction(listingId);
      expect(deactivated).toMatchObject({ error: expect.any(String) });
      const updated = await updateListingAction(listingForm("100", oneVariant, listingId));
      expect(updated).toMatchObject({ error: expect.any(String) });
      const row = await storeScoped(storeB).listing.findUnique({ where: { id: listingId } });
      const variant = await storeScoped(storeB).listingVariant.findUnique({ where: { id: variantId } });
      expect(row?.active).toBe(true);
      expect(row?.price).toBe(500);
      expect(variant?.price).toBe(500);
      expect(await storeScoped(storeB).stockEvent.count()).toBe(0);
    });

    it("float price and too many variants write no listing", async () => {
      asA(slugA, cookiesA);
      const before = await storeScoped(storeA).listing.count();
      const floated = await createListingAction(listingForm("10.5", oneVariant));
      expect(floated).toEqual({ error: "Valid non-negative price is required" });
      const many = Array.from({ length: 51 }, (_, index) => ({
        label: `v${index}`,
        price: 100,
        weightG: 500,
      }));
      const capped = await createListingAction(listingForm("100", many));
      expect(capped).toEqual({ error: "Too many variants" });
      const fileForm = listingForm("100", oneVariant);
      fileForm.set("customName", new File(["x"], "x.txt"));
      const filed = await createListingAction(fileForm);
      expect(filed).toEqual({ error: "Valid non-negative price is required" });
      const poisoned = await createListingAction(listingForm("100", [
        { label: "bag", price: true, weightG: 500, injected: true },
      ]));
      expect(poisoned).toMatchObject({ error: expect.stringMatching(/^Variant 1:/) });
      expect(poisoned).not.toHaveProperty("id");
      expect(await storeScoped(storeA).listing.count()).toBe(before);
      expect(await storeScoped(storeB).listingVariant.count()).toBe(1);
    });
  });

  describe("order", () => {
    it("guest is refused with no write", async () => {
      asGuest(slugB);
      await expect(acceptOrderAction(orderId, 10)).rejects.toThrow(/REDIRECT:\/store-admin\/sign-in/);
      const order = await storeScoped(storeB).order.findUnique({ where: { id: orderId } });
      const line = await storeScoped(storeB).orderLine.findUnique({ where: { id: lineId } });
      expect(order?.status).toBe("AUTHORIZED");
      expect(line?.qtyPicked).toBe(0);
    });

    it("store A cannot touch store B orders", async () => {
      asA(slugA, cookiesA);
      const accepted = await acceptOrderAction(orderId, 10);
      expect(accepted.ok).toBe(false);
      const picked = await markLinePickedAction(lineId);
      expect(picked.ok).toBe(false);
      const order = await storeScoped(storeB).order.findUnique({ where: { id: orderId } });
      const line = await storeScoped(storeB).orderLine.findUnique({ where: { id: lineId } });
      expect(order?.status).toBe("AUTHORIZED");
      expect(line?.status).toBe("pending");
      expect(line?.qtyPicked).toBe(0);
    });
  });

  describe("csv", () => {
    it("guest is refused with no write", async () => {
      asGuest(slugB);
      await expect(csvCommitAction("missing-token", {
        matchedRows: [],
        newItemRows: [],
        ambiguousResolutions: [],
      })).rejects.toThrow(/REDIRECT:\/store-admin\/sign-in/);
      const row = await storeScoped(storeB).listingImport.findUnique({ where: { id: importId } });
      expect(row?.status).toBe("pending");
      expect(row?.committedAt).toBeNull();
    });
  });

  describe("store-admin", () => {
    it("guest is refused with no write", async () => {
      asGuest(slugB);
      const form = new FormData();
      form.set("email", `new-${suffix}@test.example`);
      await expect(inviteMemberAction(form)).rejects.toThrow(/REDIRECT:\/store-admin\/sign-in/);
      const invite = await storeScoped(storeB).storeInvite.findUnique({ where: { id: inviteId } });
      const membership = await storeScoped(storeB).storeMembership.findFirst({ where: { userId: ownerB } });
      expect(invite?.email).toBe(`kept-${suffix}@test.example`);
      expect(membership?.role).toBe("owner");
    });

    it("store A cannot touch store B store_invites", async () => {
      asA(slugB, cookiesA);
      const form = new FormData();
      form.set("email", `intruder-${suffix}@test.example`);
      await expect(inviteMemberAction(form)).rejects.toThrow(/REDIRECT:\/store-admin\/sign-in/);
      asA(slugA, cookiesA);
      const removed = await removeMemberAction(ownerB);
      expect(removed).toMatchObject({ error: expect.any(String) });
      const invite = await storeScoped(storeB).storeInvite.findUnique({ where: { id: inviteId } });
      const membership = await storeScoped(storeB).storeMembership.findFirst({ where: { userId: ownerB } });
      expect(invite?.usedAt).toBeNull();
      expect(membership?.role).toBe("owner");
      expect(await storeScoped(storeB).storeInvite.count()).toBe(1);
    });
  });

  describe("admin", () => {
    it("guest is refused with no write", async () => {
      headerState.delete("cookie");
      headerState.delete("x-store-slug");
      await expect(setStoreStatus(storeB, "suspended")).rejects.toThrow("REDIRECT:/admin/sign-in");
      expect(await storeStatus(storeB)).toBe("active");
    });

    it("store A cannot touch store B stores", async () => {
      asA(slugA, cookiesA);
      await expect(setStoreStatus(storeB, "suspended")).rejects.toThrow("REDIRECT:/admin/sign-in");
      expect(await storeStatus(storeB)).toBe("active");
      expect(await storeScoped(storeB).auditLog.count()).toBe(1);
    });
  });

  describe("catalog", () => {
    it("guest is refused with no write", async () => {
      headerState.delete("cookie");
      await expect(approveProduct(productId)).rejects.toThrow("REDIRECT:/admin/sign-in");
      expect(await storeScoped(storeB).auditLog.count()).toBe(1);
    });

    it("store A cannot touch store B audit_logs", async () => {
      asA(slugA, cookiesA);
      await expect(approveProduct(productId)).rejects.toThrow("REDIRECT:/admin/sign-in");
      const listing = await storeScoped(storeB).listing.findUnique({ where: { id: listingId } });
      expect(listing?.masterProductId).toBe(productId);
      expect(await storeScoped(storeB).auditLog.count()).toBe(1);
      const product = await authPrisma.masterProduct.findUnique({ where: { id: productId } });
      expect(product?.status).toBe("needs_review");
    });
  });

  describe("refund", () => {
    it("guest is refused with no write", async () => {
      headerState.delete("cookie");
      const form = new FormData();
      form.set("orderId", orderId);
      form.set("note", "repaid at the bank");
      form.set("repaidDollars", "5.00");
      form.set("displayedOwedCents", "500");
      await expect(resolveRefundFailedAction(null, form)).rejects.toThrow("REDIRECT:/admin/sign-in");
      const refund = await storeScoped(storeB).refundRequest.findUnique({ where: { id: refundId } });
      const order = await storeScoped(storeB).order.findUnique({ where: { id: orderId } });
      expect(refund?.state).toBe("RESERVED");
      expect(order?.status).toBe("AUTHORIZED");
      expect(order?.notes).toBeNull();
    });

    it("store A cannot touch store B refund_requests", async () => {
      asA(slugA, cookiesA);
      const form = new FormData();
      form.set("orderId", orderId);
      form.set("note", "repaid at the bank");
      form.set("repaidDollars", "5.00");
      form.set("displayedOwedCents", "500");
      await expect(resolveRefundFailedAction(null, form)).rejects.toThrow("REDIRECT:/admin/sign-in");
      const refund = await storeScoped(storeB).refundRequest.findUnique({ where: { id: refundId } });
      expect(refund?.state).toBe("RESERVED");
      expect(refund?.amountCents).toBe(500);
    });
  });
});
