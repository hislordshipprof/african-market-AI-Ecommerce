import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState, headerQueue } = vi.hoisted(() => ({
  headerState: new Headers(),
  headerQueue: [] as Headers[],
}));

vi.mock("next/headers", () => ({
  headers: async () => headerQueue.shift() ?? headerState,
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));

import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { generateTOTP } from "../../../e2e/totp";
import { auth } from "../auth";
import { authPrisma, findStuckTransitionalOrders, platformSessionUser, storeScoped, storeScopedTransaction } from "../db";
import { recordReconcileResult } from "../inngest/functions";
import { setStripeProvider } from "../stripe";
import { fakeStripeProvider, refundRequests, reset, setAuthorizedAmount, setNextRefundFailure, setNextRefundStatus, setRefundCreatedLate, setRefundStatus } from "../stripe/fake";
import { RefundNotCreatedError } from "../stripe/errors";
import { applyProviderRefund, clearReplayCallsForTests, evaluateOrderRefundState, reconcileRefundRequest, REFUND_REQUEST_ABANDON_MS } from "../order/refund-requests";
import { autoCancelOrder, markTerminalRefundFailure, reconcileStuckOrder } from "../order/service";
import { failedAtLabel } from "./failed-at";
import { listRefundFailedOrders, resolveRefundFailed, resolveRefundFailedAction } from "./refund-resolution";
import { parseRepaidDollars } from "./repaid-dollars";

const BASE = "http://localhost:3000/api/auth";
const RUN = `t264-${Date.now()}`;
const password = "RefundResolve-186!";
const hasDb = !!process.env.DATABASE_URL;

describe("repaid dollars", () => {
  it("repaid dollars parsing and caps are unchanged under the schema", () => {
    expect(parseRepaidDollars("10.5")).toBe(1050);
    expect(parseRepaidDollars("10.50")).toBe(1050);
    expect(parseRepaidDollars("10.005")).toBeNull();
    expect(parseRepaidDollars("-1")).toBeNull();
    expect(parseRepaidDollars("1e3")).toBeNull();
    expect(parseRepaidDollars("100000000")).toBeNull();
  });
});

const olderFailureAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
async function secondAuditAt(storeId: string, orderId: string, refundId: string): Promise<Date> {
  const rows = await storeScoped(storeId).auditLog.findMany({
    where: { entityId: orderId, action: "refund_failed" },
    orderBy: { createdAt: "asc" },
  });
  const match = rows.find((row) => (row.after as { refundId?: string }).refundId === refundId);
  if (!match) throw new Error("missing failure audit");
  return match.createdAt;
}

class CookieJar {
  private readonly jar = new Map<string, string>();

  apply(response: Response): void {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const semi = raw.indexOf(";");
      const pair = (semi === -1 ? raw : raw.slice(0, semi)).trim();
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

async function authPost(path: string, body: unknown, cookies?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies) headers.cookie = cookies;
  return auth.handler(
    new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

async function signInWithTotp(email: string): Promise<string> {
  const jar = new CookieJar();
  const signedIn = await authPost("/sign-in/email", { email, password });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  jar.apply(signedIn);
  const enabled = await authPost("/two-factor/enable", { password }, jar.header());
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  jar.apply(enabled);
  const body = (await enabled.json()) as { totpURI?: string };
  const secret = new URL(body.totpURI ?? "http://localhost").searchParams.get("secret");
  expect(secret).toBeTruthy();
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret!) }, jar.header());
  expect(verified.status, await verified.clone().text()).toBe(200);
  jar.apply(verified);
  return jar.header();
}

function asAdmin(cookies: string): void {
  headerState.set("cookie", cookies);
}

describe.skipIf(!hasDb)("refund resolution (real auth.handler, lane DB)", () => {
  const storeAId = crypto.randomUUID();
  const storeBId = crypto.randomUUID();
  const emailAdmin = `admin-${RUN}@example.com`;
  const emailAdmin2 = `admin2-${RUN}@example.com`;
  const emailOwner = `owner-${RUN}@example.com`;
  const emailBare = `bare-${RUN}@example.com`;
  let adminId = "";
  let cookiesAdmin = "";
  let cookiesAdmin2 = "";
  let cookiesOwner = "";
  let cookiesBare = "";
  let orderId = "";

  beforeAll(async () => {
    expect(await platformSessionUser()).toBe("app_runtime");
    setStripeProvider(fakeStripeProvider);
    reset();

    for (const [email, name] of [
      [emailAdmin, "Admin One"],
      [emailAdmin2, "Admin Two"],
      [emailOwner, "Store Owner"],
      [emailBare, "Bare Admin"],
    ] as const) {
      const res = await authPost("/sign-up/email", { email, password, name });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    adminId = (await authPrisma.user.findFirstOrThrow({ where: { email: emailAdmin } })).id;
    const admin2Id = (await authPrisma.user.findFirstOrThrow({ where: { email: emailAdmin2 } })).id;
    const ownerId = (await authPrisma.user.findFirstOrThrow({ where: { email: emailOwner } })).id;
    const bareId = (await authPrisma.user.findFirstOrThrow({ where: { email: emailBare } })).id;
    await authPrisma.user.update({ where: { id: adminId }, data: { role: "platform_admin" } });
    await authPrisma.user.update({ where: { id: admin2Id }, data: { role: "platform_admin" } });
    await authPrisma.user.update({ where: { id: bareId }, data: { role: "platform_admin" } });

    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, timezone, updated_at) VALUES (${storeAId}, ${"Resolve A " + RUN}, ${"a-" + RUN}, 'active', 'America/Chicago', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, timezone, updated_at) VALUES (${storeBId}, ${"Resolve B " + RUN}, ${"b-" + RUN}, 'active', 'America/New_York', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeAId}, ${ownerId}, 'owner', now())`;
    });

    cookiesAdmin = await signInWithTotp(emailAdmin);
    cookiesAdmin2 = await signInWithTotp(emailAdmin2);
    cookiesOwner = await signInWithTotp(emailOwner);
    const bareJar = new CookieJar();
    const bareSignIn = await authPost("/sign-in/email", { email: emailBare, password });
    expect(bareSignIn.status).toBe(200);
    bareJar.apply(bareSignIn);
    cookiesBare = bareJar.header();

    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Refund Customer" },
    });
    const pi = `pi_resolve_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap");
    const covered = await fakeStripeProvider.refundPayment(pi, 400, "ok");
    expect(covered.status).toBe("succeeded");
    const failed = await fakeStripeProvider.refundPayment(pi, 300, "bad");
    setRefundStatus(failed.refundId, "failed");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26401,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
        refundId: failed.refundId,
      },
    });
    orderId = order.id;
    await storeScopedTransaction(storeAId, async (tx) => {
      await tx.auditLog.create({
        data: {
          storeId: storeAId,
          actorId: adminId,
          actorEmail: emailAdmin,
          action: "refund_failed",
          entityType: "order",
          entityId: orderId,
          after: { refundId: failed.refundId, alert: "store_and_platform" },
        },
      });
    });
  });

  afterAll(async () => {
    setStripeProvider(null);
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.auditLog.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } });
      await tx.order.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } });
      await tx.customer.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } });
      await tx.storeMembership.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } });
      await tx.store.deleteMany({ where: { id: { in: [storeAId, storeBId] } } });
    });
    await authPrisma.user.deleteMany({
      where: { email: { in: [emailAdmin, emailAdmin2, emailOwner, emailBare] } },
    });
  });

  it("the amount owed is captured minus succeeded refunds", async () => {
    asAdmin(cookiesAdmin);
    const rows = await listRefundFailedOrders();
    const row = rows.find((item) => item.orderId === orderId);
    expect(row?.capturedCents).toBe(1000);
    expect(row?.refundedCents).toBe(400);
    expect(row?.owedCents).toBe(600);
    expect(row?.failedAtLabel).toContain("America/Chicago");
  });

  it("store owners and staff cannot resolve a refund-failed order", async () => {
    asAdmin(cookiesOwner);
    await expect(resolveRefundFailed(orderId, "owner tried", 600, 600)).rejects.toSatisfy((error: unknown) => {
      return isRedirectError(error) && getURLFromRedirectError(error) === "/admin/sign-in";
    });
    const after = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe("REFUND_FAILED");
  });

  it("an admin without 2FA cannot resolve", async () => {
    asAdmin(cookiesBare);
    await expect(resolveRefundFailed(orderId, "no second factor", 600, 600)).rejects.toSatisfy((error: unknown) => {
      return isRedirectError(error) && getURLFromRedirectError(error) === "/admin/enroll-2fa";
    });
    const after = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe("REFUND_FAILED");
  });

  it("signed-out callers cannot resolve", async () => {
    headerState.delete("cookie");
    await expect(resolveRefundFailed(orderId, "signed out", 600, 600)).rejects.toSatisfy((error: unknown) => {
      return isRedirectError(error) && getURLFromRedirectError(error) === "/admin/sign-in";
    });
    const after = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe("REFUND_FAILED");
  });

  it("an empty, whitespace or 501-character note is refused", async () => {
    asAdmin(cookiesAdmin);
    for (const note of ["", "   ", "x".repeat(501)]) {
      const result = await resolveRefundFailed(orderId, note, 600, 600);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.fieldError).toMatch(/1–500/);
    }
    const after = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe("REFUND_FAILED");
    const note = "x".repeat(500);
    const accepted = await resolveRefundFailed(orderId, note, 600, 600);
    expect(accepted).toEqual({ ok: true });
    const resolved = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(resolved?.status).toBe("CANCELLED");
    expect(resolved?.notes).toBe(note);
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.order.update({
        where: { id: orderId },
        data: { status: "REFUND_FAILED", notes: null, cancelledAt: null, capturedAmountCents: 1000 },
      });
      await tx.auditLog.deleteMany({ where: { entityId: orderId, action: "refund_resolved_manually" } });
    });
  });

  it("resolving keeps the customer's existing note", async () => {
    asAdmin(cookiesAdmin);
    await storeScopedTransaction(storeAId, async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { status: "REFUND_FAILED", notes: "Call before 5pm — no onions." },
      });
    });
    const result = await resolveRefundFailed(orderId, "Paid customer by Zelle 11/05", 600, 600);
    expect(result).toEqual({ ok: true });
    const updated = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(updated?.notes).toBe("Call before 5pm — no onions.\nPaid customer by Zelle 11/05");
    const audit = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: orderId, action: "refund_resolved_manually" },
    });
    expect(audit?.after).toMatchObject({ note: "Paid customer by Zelle 11/05" });
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.order.update({
        where: { id: orderId },
        data: { status: "REFUND_FAILED", notes: null, cancelledAt: null, capturedAmountCents: 1000 },
      });
      await tx.auditLog.deleteMany({ where: { entityId: orderId, action: "refund_resolved_manually" } });
    });
  });

  it("a platform admin resolves a refund-failed order with a note", async () => {
    asAdmin(cookiesAdmin);
    const before = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(before?.status).toBe("REFUND_FAILED");
    expect(before?.capturedAmountCents).toBe(1000);
    const result = await resolveRefundFailed(orderId, "Paid customer by Zelle 11/05", 600, 600);
    expect(result).toEqual({ ok: true });
    const updated = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(updated?.status).toBe("CANCELLED");
    expect(updated?.capturedAmountCents).toBeNull();
    expect(updated?.notes).toBe("Paid customer by Zelle 11/05");
    const audit = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: orderId, action: "refund_resolved_manually" },
    });
    expect(audit?.actorId).toBe(adminId);
    expect(audit?.after).toMatchObject({
      note: "Paid customer by Zelle 11/05",
      alert: "store",
      capturedCents: 1000,
      repaidCents: 600,
      refundedCents: 400,
    });
    const gapAlerts = await storeScoped(storeAId).auditLog.findMany({
      where: {
        entityId: orderId,
        action: { in: ["refund_after_manual_resolution", "refund_reversed_after_resolution"] },
      },
    });
    expect(gapAlerts).toHaveLength(0);
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.order.update({
        where: { id: orderId },
        data: { status: "REFUND_FAILED", notes: null, cancelledAt: null, capturedAmountCents: 1000 },
      });
      await tx.auditLog.deleteMany({ where: { entityId: orderId, action: "refund_resolved_manually" } });
    });
  });

  it("two concurrent resolves write one transition and one audit row", async () => {
    expect(cookiesAdmin2).toContain("better-auth");
    headerQueue.push(new Headers({ cookie: cookiesAdmin }), new Headers({ cookie: cookiesAdmin2 }));
    const [first, second] = await Promise.all([
      resolveRefundFailed(orderId, "first admin", 600, 600),
      resolveRefundFailed(orderId, "second admin", 600, 600),
    ]);
    const results = [first, second];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error === "already resolved")).toHaveLength(1);
    const audits = await storeScoped(storeAId).auditLog.findMany({
      where: { entityId: orderId, action: "refund_resolved_manually" },
    });
    expect(audits).toHaveLength(1);
    const updated = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(updated?.status).toBe("CANCELLED");
    expect(updated?.capturedAmountCents).toBeNull();
  });

  it("a cancelled capture whose refund fails still shows the Stripe amount owed", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Owed Customer" },
    });
    const pi = `pi_owed_${RUN}`;
    setAuthorizedAmount(pi, 2500);
    await fakeStripeProvider.capturePaymentIntent(pi, 2500, "cap-owed");
    const refund = await fakeStripeProvider.refundPayment(pi, 2500, "ref-owed");
    setRefundStatus(refund.refundId, "failed");
    const owed = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26402,
        customerId: customer.id,
        status: "CANCELLING",
        fulfillment: "pickup",
        subtotalCents: 2500,
        bufferCents: 0,
        totalAuthorizedCents: 2500,
        totalCents: 2500,
        capturedAmountCents: null,
        paymentIntentId: pi,
        refundId: refund.refundId,
      },
    });
    expect(
      await markTerminalRefundFailure({
        paymentIntentId: pi,
        refundId: refund.refundId,
        refundStatus: "failed",
      }),
    ).toEqual({ ok: true, action: "refund_failed" });
    const stored = await storeScoped(storeAId).order.findUnique({ where: { id: owed.id } });
    expect(stored?.status).toBe("REFUND_FAILED");
    expect(stored?.capturedAmountCents).toBe(2500);

    const stalePi = `pi_stale_${RUN}`;
    setAuthorizedAmount(stalePi, 1800);
    await fakeStripeProvider.capturePaymentIntent(stalePi, 1800, "cap-stale");
    const stale = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26403,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1800,
        bufferCents: 0,
        totalAuthorizedCents: 1800,
        totalCents: 1800,
        capturedAmountCents: null,
        paymentIntentId: stalePi,
      },
    });
    const rows = await listRefundFailedOrders();
    expect(rows.find((item) => item.orderId === owed.id)).toMatchObject({
      capturedCents: 2500,
      refundedCents: 0,
      owedCents: 2500,
    });
    expect(rows.find((item) => item.orderId === stale.id)).toMatchObject({
      capturedCents: 1800,
      owedCents: 1800,
    });
  });

  it("resolving one store leaves the other store's refund-failed order unchanged", async () => {
    const customerB = await storeScoped(storeBId).customer.create({
      data: { storeId: storeBId, name: "Other Customer" },
    });
    const other = await storeScoped(storeBId).order.create({
      data: {
        storeId: storeBId,
        number: 26404,
        customerId: customerB.id,
        status: "REFUND_FAILED",
        fulfillment: "delivery",
        subtotalCents: 700,
        bufferCents: 0,
        totalAuthorizedCents: 700,
        totalCents: 700,
        capturedAmountCents: 700,
        notes: null,
      },
    });
    const targetCustomer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Target Customer" },
    });
    const target = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26405,
        customerId: targetCustomer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 900,
        bufferCents: 0,
        totalAuthorizedCents: 900,
        totalCents: 900,
        capturedAmountCents: 900,
      },
    });
    asAdmin(cookiesAdmin);
    const result = await resolveRefundFailed(target.id, "Repaid store A only", 900, 900);
    expect(result).toEqual({ ok: true });
    const resolved = await storeScoped(storeAId).order.findUnique({ where: { id: target.id } });
    expect(resolved?.status).toBe("CANCELLED");
    const untouched = await storeScoped(storeBId).order.findUnique({ where: { id: other.id } });
    expect(untouched?.status).toBe("REFUND_FAILED");
    expect(untouched?.notes).toBeNull();
    expect(untouched?.capturedAmountCents).toBe(700);
  });

  it("a stale sweep does not reopen a refund an admin already repaid", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Sweep Customer" },
    });
    const pi = `pi_stale_sweep_${RUN}`;
    setAuthorizedAmount(pi, 2500);
    await fakeStripeProvider.capturePaymentIntent(pi, 2500, "cap-stale-sweep");
    const refund = await fakeStripeProvider.refundPayment(pi, 2500, "ref-stale-sweep");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26406,
        customerId: customer.id,
        status: "CANCELLING",
        fulfillment: "pickup",
        subtotalCents: 2500,
        bufferCents: 0,
        totalAuthorizedCents: 2500,
        totalCents: 2500,
        capturedAmountCents: null,
        paymentIntentId: pi,
        refundId: refund.refundId,
      },
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = fakeStripeProvider.retrieveRefund.bind(fakeStripeProvider);
    vi.spyOn(fakeStripeProvider, "retrieveRefund").mockImplementation(async (id: string) => {
      if (id === refund.refundId) {
        entered();
        await gate;
      }
      return original(id);
    });

    const reconcile = reconcileStuckOrder(storeAId, order.id);
    try {
      await enteredGate;
      setRefundStatus(refund.refundId, "failed");
      expect(
        await markTerminalRefundFailure({
          paymentIntentId: pi,
          refundId: refund.refundId,
          refundStatus: "failed",
        }),
      ).toEqual({ ok: true, action: "refund_failed" });
      expect(await resolveRefundFailed(order.id, "Paid customer by Zelle", 2500, 2500)).toEqual({ ok: true });
      release();
      await reconcile;
    } finally {
      release();
      vi.restoreAllMocks();
      setStripeProvider(fakeStripeProvider);
    }

    const updated = await storeScoped(storeAId).order.findUnique({ where: { id: order.id } });
    expect(updated?.status).toBe("CANCELLED");
    const resolutions = await storeScoped(storeAId).auditLog.findMany({
      where: { entityId: order.id, action: "refund_resolved_manually" },
    });
    expect(resolutions).toHaveLength(1);
  });

  it("a stale empty refund list does not refund again after manual repayment", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Stale List Customer" },
    });
    const pi = `pi_stale_list_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap-stale-list");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26407,
        customerId: customer.id,
        status: "CANCELLING",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
        refundId: null,
      },
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = fakeStripeProvider.listRefunds.bind(fakeStripeProvider);
    let listed = 0;
    vi.spyOn(fakeStripeProvider, "listRefunds").mockImplementation(async (id: string) => {
      const live = await original(id);
      const snapshot = live.map((refund) => ({ ...refund }));
      listed += 1;
      if (listed === 1) {
        entered();
        await gate;
        return snapshot;
      }
      return original(id);
    });

    const reconcile = reconcileStuckOrder(storeAId, order.id);
    try {
      await enteredGate;
      const cancelled = await autoCancelOrder(storeAId, order.id);
      expect(cancelled.ok).toBe(true);
      const first = (await original(pi)).find((refund) => refund.status === "succeeded");
      expect(first).toBeTruthy();
      setRefundStatus(first!.refundId, "failed");
      expect(
        await markTerminalRefundFailure({
          paymentIntentId: pi,
          refundId: first!.refundId,
          refundStatus: "failed",
        }),
      ).toEqual({ ok: true, action: "refund_failed" });
      expect(await resolveRefundFailed(order.id, "Paid customer by Zelle", 1000, 1000)).toEqual({ ok: true });
      const before = (await original(pi))
        .filter((refund) => refund.status === "succeeded")
        .reduce((sum, refund) => sum + refund.amountRefunded, 0);
      expect(before).toBe(0);
      release();
      await reconcile;
    } finally {
      release();
      vi.restoreAllMocks();
      setStripeProvider(fakeStripeProvider);
    }

    const after = (await fakeStripeProvider.listRefunds(pi))
      .filter((refund) => refund.status === "succeeded")
      .reduce((sum, refund) => sum + refund.amountRefunded, 0);
    expect(after).toBe(0);
    const updated = await storeScoped(storeAId).order.findUnique({ where: { id: order.id } });
    expect(updated?.status).toBe("CANCELLED");
  });

  it("a lost refund response does not block repayment after the refund fails", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Lost Response Customer" },
    });
    const pi = `pi_lost_response_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap-lost-response");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26408,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    const original = fakeStripeProvider.refundPayment.bind(fakeStripeProvider);
    let savedRefundId = "";
    const spy = vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async (...args) => {
      const refund = await original(...args);
      savedRefundId = refund.refundId;
      throw Object.assign(new Error("response lost after provider commit"), { type: "StripeConnectionError" });
    });
    await expect(autoCancelOrder(storeAId, order.id)).rejects.toThrow(/response lost after provider commit/);
    spy.mockRestore();
    setStripeProvider(fakeStripeProvider);

    const settled = await reconcileStuckOrder(storeAId, order.id);
    expect(settled.ok).toBe(true);
    setRefundStatus(savedRefundId, "failed");
    expect(
      await markTerminalRefundFailure({
        paymentIntentId: pi,
        refundId: savedRefundId,
        refundStatus: "failed",
      }),
    ).toEqual({ ok: true, action: "refund_failed" });

    expect(await resolveRefundFailed(order.id, "Paid customer by Zelle", 1000, 1000)).toEqual({ ok: true });
    const updated = await storeScoped(storeAId).order.findUnique({ where: { id: order.id } });
    expect(updated?.status).toBe("CANCELLED");
  });

  it.each([false, true])("a pending remainder blocks repayment after an older refund fails (lost response %s)", async (lost) => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: `Review pending ${lost}` },
    });
    const pi = `pi_review_pending_${lost}_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, `review-cap-${lost}`);
    const older = await fakeStripeProvider.refundPayment(pi, 400, `review-old-${lost}`);
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: lost ? 26491 : 26490,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    setNextRefundStatus(pi, "pending");
    if (lost) {
      const original = fakeStripeProvider.refundPayment.bind(fakeStripeProvider);
      const spy = vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async (...args) => {
        await original(...args);
        throw Object.assign(new Error("review response lost"), { type: "StripeConnectionError" });
      });
      await expect(autoCancelOrder(storeAId, order.id)).rejects.toThrow("review response lost");
      spy.mockRestore();
      setStripeProvider(fakeStripeProvider);
    } else {
      expect((await autoCancelOrder(storeAId, order.id)).ok).toBe(false);
    }
    const pending = (await fakeStripeProvider.listRefunds(pi)).find((refund) => refund.status === "pending");
    expect(pending?.amountRefunded).toBe(600);
    setRefundStatus(older.refundId, "failed");
    expect(
      await markTerminalRefundFailure({
        paymentIntentId: pi,
        refundId: older.refundId,
        refundStatus: "failed",
      }),
    ).toEqual({ ok: true, action: "refund_failed" });
    const queue = (await listRefundFailedOrders()).find((row) => row.orderId === order.id);
    expect(queue?.owedCents).toBe(1000);
    expect(queue?.bankRefundPending).toBe(true);
    const result = await resolveRefundFailed(order.id, "Paid displayed 1000 cents by Zelle", 1000, 1000);
    const stored = await storeScoped(storeAId).order.findUnique({ where: { id: order.id } });
    expect(result.ok).toBe(false);
    expect(stored?.status).toBe("REFUND_FAILED");
  });

  it("a pending remainder that later succeeds can be repaid for what is still owed", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Pending then succeeded" },
    });
    const pi = `pi_review_pending_done_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "review-cap-done");
    const older = await fakeStripeProvider.refundPayment(pi, 400, "review-old-done");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26493,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    setNextRefundStatus(pi, "pending");
    expect((await autoCancelOrder(storeAId, order.id)).ok).toBe(false);
    const pending = (await fakeStripeProvider.listRefunds(pi)).find((refund) => refund.status === "pending");
    expect(pending?.amountRefunded).toBe(600);
    setRefundStatus(older.refundId, "failed");
    expect(
      await markTerminalRefundFailure({
        paymentIntentId: pi,
        refundId: older.refundId,
        refundStatus: "failed",
      }),
    ).toEqual({ ok: true, action: "refund_failed" });
    expect((await resolveRefundFailed(order.id, "Too early", 1000, 1000)).ok).toBe(false);
    setRefundStatus(pending!.refundId, "succeeded");
    const queue = (await listRefundFailedOrders()).find((row) => row.orderId === order.id);
    expect(queue?.bankRefundPending).toBe(false);
    expect(queue?.owedCents).toBe(400);
    expect(await resolveRefundFailed(order.id, "Paid the remaining 400 cents by Zelle", 400, 400)).toEqual({ ok: true });
    const stored = await storeScoped(storeAId).order.findUnique({ where: { id: order.id } });
    expect(stored?.status).toBe("CANCELLED");
  });

  it("adversarial late bank write after manual repayment", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Adversarial late bank write" },
    });
    const pi = `pi_adversarial_late_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "adversarial-cap");
    const older = await fakeStripeProvider.refundPayment(pi, 400, "adversarial-old");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26494,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = fakeStripeProvider.refundPayment.bind(fakeStripeProvider);
    const spy = vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const cancel = autoCancelOrder(storeAId, order.id);
    try {
      await enteredGate;
      const dashboard = await original(pi, 100, "review9-dashboard");
      expect(dashboard.status).toBe("succeeded");
      setRefundStatus(older.refundId, "failed");
      const webhook = await markTerminalRefundFailure({
        paymentIntentId: pi,
        refundId: older.refundId,
        refundStatus: "failed",
      });
      const queue = (await listRefundFailedOrders()).find((row) => row.orderId === order.id);
      const manual = await resolveRefundFailed(order.id, "Paid displayed 900 cents by Zelle", 900, 900);
      expect(webhook).toEqual({ ok: true, action: "refund_failed" });
      expect(queue?.owedCents).toBe(900);
      expect(queue?.bankRefundPending).toBe(true);
      expect(manual.ok).toBe(false);
      const stored = await storeScoped(storeAId).order.findUnique({ where: { id: order.id } });
      expect(stored?.status).toBe("REFUND_FAILED");
    } finally {
      release();
      await cancel.catch(() => {});
      spy.mockRestore();
      setStripeProvider(fakeStripeProvider);
    }
  });

  it("a covering dashboard refund does not release the reserved request", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Covering dashboard refund" },
    });
    const pi = `pi_covering_dashboard_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "covering-cap");
    await fakeStripeProvider.refundPayment(pi, 400, "covering-old");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26495,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = fakeStripeProvider.refundPayment.bind(fakeStripeProvider);
    const spy = vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const cancel = autoCancelOrder(storeAId, order.id);
    try {
      await enteredGate;
      const dashboard = await original(pi, 600, "review10-dashboard");
      expect(dashboard.status).toBe("succeeded");
      const swept = await reconcileStuckOrder(storeAId, order.id);
      setRefundStatus(dashboard.refundId, "failed");
      const webhook = await markTerminalRefundFailure({
        paymentIntentId: pi,
        refundId: dashboard.refundId,
        refundStatus: "failed",
      });
      const queue = (await listRefundFailedOrders()).find((row) => row.orderId === order.id);
      const manual = await resolveRefundFailed(order.id, "Paid displayed 600 cents by Zelle", 600, 600);
      expect(swept).toEqual({ ok: false, error: "Refund is still confirming with the bank", waiting: true });
      expect(webhook).toEqual({ ok: true, action: "refund_failed" });
      expect(queue?.owedCents).toBe(600);
      expect(queue?.bankRefundPending).toBe(true);
      expect(manual.ok).toBe(false);
      const stored = await storeScoped(storeAId).order.findUnique({ where: { id: order.id } });
      expect(stored?.status).toBe("REFUND_FAILED");
    } finally {
      release();
      await cancel.catch(() => {});
      spy.mockRestore();
      setStripeProvider(fakeStripeProvider);
    }
  });

  it("a failed refund found by the sweep can be repaid", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Review lost then failed" },
    });
    const pi = `pi_review_failed_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "review-failed-cap");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26492,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    const original = fakeStripeProvider.refundPayment.bind(fakeStripeProvider);
    let refundId = "";
    const spy = vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async (...args) => {
      const refund = await original(...args);
      refundId = refund.refundId;
      throw Object.assign(new Error("review response lost"), { type: "StripeConnectionError" });
    });
    await expect(autoCancelOrder(storeAId, order.id)).rejects.toThrow("review response lost");
    spy.mockRestore();
    setStripeProvider(fakeStripeProvider);
    setRefundStatus(refundId, "failed");
    await reconcileStuckOrder(storeAId, order.id);
    const result = await resolveRefundFailed(order.id, "Customer repaid outside app", 1000, 1000);
    const stored = await storeScoped(storeAId).order.findUnique({ where: { id: order.id } });
    expect(result).toEqual({ ok: true });
    expect(stored?.status).toBe("CANCELLED");
  });

  it("an unknown refund request blocks repayment until Stripe executes it late", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Late unknown refund" },
    });
    const pi = `pi_late_unknown_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "late-cap");
    const older = await fakeStripeProvider.refundPayment(pi, 400, "late-older");
    setNextRefundFailure(pi, 1);
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26501,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    await expect(autoCancelOrder(storeAId, order.id)).rejects.toThrow(/internal server error/i);
    setRefundStatus(older.refundId, "failed");
    await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: older.refundId,
      refundStatus: "failed",
    });
    const refused = await resolveRefundFailed(order.id, "too soon", 1000, 1000);
    expect(refused.ok).toBe(false);
    const request = await storeScoped(storeAId).refundRequest.findFirst({ where: { orderId: order.id } });
    expect(request?.state).toBe("UNKNOWN");
    setRefundCreatedLate(request!.key);
    await reconcileStuckOrder(storeAId, order.id);
    const queue = (await listRefundFailedOrders()).find((row) => row.orderId === order.id);
    expect(queue?.owedCents).toBe(400);
    expect(queue?.bankRefundPending).toBe(false);
    const manual = await resolveRefundFailed(order.id, "Paid the remaining 400 by Zelle", 400, 400);
    expect(manual).toEqual({ ok: true });
    const audit = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_resolved_manually" },
    });
    expect(audit?.after).toMatchObject({ repaidCents: 400, refundedCents: 600, capturedCents: 1000 });
  });

  it("a request that never reached Stripe becomes resolvable once the key replay proves it was not created", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Never created" },
    });
    const pi = `pi_never_created_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "never-cap");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26502,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    const spy = vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async () => {
      throw Object.assign(new Error("connection"), { type: "StripeConnectionError" });
    });
    await expect(autoCancelOrder(storeAId, order.id)).rejects.toThrow(/connection/);
    await storeScoped(storeAId).order.update({ where: { id: order.id }, data: { status: "REFUND_FAILED" } });
    spy.mockImplementation(async () => {
      throw new RefundNotCreatedError("charge_already_refunded", "Charge has already been refunded.");
    });
    try {
      await reconcileStuckOrder(storeAId, order.id);
    } finally {
      spy.mockRestore();
      setStripeProvider(fakeStripeProvider);
    }
    const request = await storeScoped(storeAId).refundRequest.findFirst({ where: { orderId: order.id } });
    expect(request?.state).toBe("NOT_CREATED");
    const manual = await resolveRefundFailed(order.id, "Paid the full 1000 by Zelle", 1000, 1000);
    expect(manual).toEqual({ ok: true });
    const audit = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_resolved_manually" },
    });
    expect(audit?.after).toMatchObject({ repaidCents: 1000 });
  });

  it("a cached 500 followed by a failed dashboard refund is resolvable after 23 hours", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Cached 500" },
    });
    const pi = `pi_cached_500_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cached-cap");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26503,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    setNextRefundFailure(pi, 1);
    await expect(autoCancelOrder(storeAId, order.id)).rejects.toThrow(/internal server error/i);
    const dashboard = await fakeStripeProvider.refundPayment(pi, 1000, "cached-dashboard");
    setRefundStatus(dashboard.refundId, "failed");
    await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: dashboard.refundId,
      refundStatus: "failed",
    });
    const refused = await resolveRefundFailed(order.id, "still unknown", 1000, 1000);
    expect(refused.ok).toBe(false);
    const request = await storeScoped(storeAId).refundRequest.findFirstOrThrow({ where: { orderId: order.id } });
    await storeScoped(storeAId).refundRequest.update({
      where: { id: request.id },
      data: { createdAt: new Date(Date.now() - 23 * 60 * 60 * 1000 - 1000) },
    });
    await reconcileStuckOrder(storeAId, order.id);
    const abandoned = await storeScoped(storeAId).refundRequest.findFirstOrThrow({ where: { orderId: order.id } });
    expect(abandoned.state).toBe("ABANDONED");
    const alert = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_request_unknown" },
    });
    expect(alert?.after).toMatchObject({ alert: "platform" });
    const manual = await resolveRefundFailed(order.id, "Paid 1000 by Zelle after the bank never answered", 1000, 1000);
    expect(manual).toEqual({ ok: true });
    const audit = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_resolved_manually" },
    });
    expect(audit?.after).toMatchObject({ repaidCents: 1000 });
  });

  it("an older failure with an unknown request never executed resolves after 23 hours", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Older failure" },
    });
    const pi = `pi_older_unknown_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "older-cap");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26504,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    const original = fakeStripeProvider.refundPayment.bind(fakeStripeProvider);
    const spy = vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async () => {
      throw Object.assign(new Error("connection"), { type: "StripeConnectionError" });
    });
    await expect(autoCancelOrder(storeAId, order.id)).rejects.toThrow(/connection/);
    const failed = await original(pi, 1000, "older-failed");
    setRefundStatus(failed.refundId, "failed");
    await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: failed.refundId,
      refundStatus: "failed",
    });
    expect((await resolveRefundFailed(order.id, "before the window", 1000, 1000)).ok).toBe(false);
    spy.mockRestore();
    setStripeProvider(fakeStripeProvider);
    const request = await storeScoped(storeAId).refundRequest.findFirstOrThrow({ where: { orderId: order.id } });
    await storeScoped(storeAId).refundRequest.update({
      where: { id: request.id },
      data: { createdAt: new Date(Date.now() - 23 * 60 * 60 * 1000 - 1000) },
    });
    await reconcileStuckOrder(storeAId, order.id);
    const queue = (await listRefundFailedOrders()).find((row) => row.orderId === order.id);
    expect(queue?.owedCents).toBe(1000);
    expect(queue?.bankRefundPending).toBe(false);
    const manual = await resolveRefundFailed(order.id, "Paid 1000 by Zelle", 1000, 1000);
    expect(manual).toEqual({ ok: true });
  });

  it("manual resolution records the repaid amount", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Repaid amount" },
    });
    const pi = `pi_repaid_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "repaid-cap");
    await fakeStripeProvider.refundPayment(pi, 400, "repaid-ok");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26505,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    const manual = await resolveRefundFailed(order.id, "Paid 600 by Zelle", 600, 600);
    expect(manual).toEqual({ ok: true });
    const audit = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_resolved_manually" },
    });
    expect(audit?.after).toMatchObject({
      note: "Paid 600 by Zelle",
      alert: "store",
      repaidCents: 600,
      refundedCents: 400,
      capturedCents: 1000,
    });
    const stored = await storeScoped(storeAId).order.findUnique({ where: { id: order.id } });
    expect(stored?.status).toBe("CANCELLED");
    expect(stored?.capturedAmountCents).toBeNull();
  });

  it("a counted refund failing after manual resolution alerts without reopening", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Underpaid later" },
    });
    const pi = `pi_underpaid_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "under-cap");
    const counted = await fakeStripeProvider.refundPayment(pi, 400, "under-counted");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26506,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
        refundId: counted.refundId,
      },
    });
    expect(await resolveRefundFailed(order.id, "Paid 600 by Zelle", 600, 600)).toEqual({ ok: true });
    setRefundStatus(counted.refundId, "failed");
    const webhook = await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: counted.refundId,
      refundStatus: "failed",
    });
    expect(webhook).toEqual({ ok: true, action: "already_resolved" });
    const stored = await storeScoped(storeAId).order.findUnique({ where: { id: order.id } });
    expect(stored?.status).toBe("CANCELLED");
    expect(stored?.capturedAmountCents).toBeNull();
    const manual = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_resolved_manually" },
    });
    expect(manual?.after).toMatchObject({ capturedCents: 1000, repaidCents: 600, refundedCents: 400 });
    const alert = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_reversed_after_resolution" },
    });
    expect(alert?.after).toMatchObject({ underpaidCents: 400, refundId: counted.refundId, alert: "store_and_platform" });
  });

  it("a refund succeeding after manual resolution raises an overpayment alert", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Overpaid later" },
    });
    const pi = `pi_overpaid_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "over-cap");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26507,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    expect(await resolveRefundFailed(order.id, "Paid 1000 by Zelle", 1000, 1000)).toEqual({ ok: true });
    const late = await fakeStripeProvider.refundPayment(pi, 600, "over-late");
    await applyProviderRefund({ ...late, paymentIntentId: pi });
    const stored = await storeScoped(storeAId).order.findUnique({ where: { id: order.id } });
    expect(stored?.status).toBe("CANCELLED");
    expect(stored?.capturedAmountCents).toBeNull();
    const manual = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_resolved_manually" },
    });
    expect(manual?.after).toMatchObject({ capturedCents: 1000, repaidCents: 1000, refundedCents: 0 });
    const alert = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_after_manual_resolution" },
    });
    expect(alert?.after).toMatchObject({ overpaidCents: 600, refundId: late.refundId, alert: "store_and_platform" });
    expect(refundRequests.filter((request) => request.paymentIntentId === pi)).toHaveLength(1);
  });

  it("a failed order that later becomes fully refunded is cancelled by sweep", async () => {
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Sweep full cover" },
    });
    const pi = `pi_sweep_cover_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "sweep-cover-cap");
    const failed = await fakeStripeProvider.refundPayment(pi, 1000, "sweep-cover-fail");
    setRefundStatus(failed.refundId, "failed");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26510,
        customerId: customer.id,
        status: "CANCELLING",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
        refundId: failed.refundId,
      },
    });
    expect(await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: failed.refundId,
      refundStatus: "failed",
    })).toEqual({ ok: true, action: "refund_failed" });
    await fakeStripeProvider.refundPayment(pi, 1000, "sweep-cover-ok");
    const candidates = await findStuckTransitionalOrders();
    const selected = candidates.filter((row) => row.id === order.id);
    expect(selected).toHaveLength(1);
    for (const candidate of selected) await recordReconcileResult(candidate.storeId, candidate.id);
    expect((await storeScoped(storeAId).order.findUnique({ where: { id: order.id } }))?.status).toBe("CANCELLED");
  });

  function holdSecondRefundRead(pi: string): {
    entered: Promise<void>;
    release: () => void;
  } {
    const original = fakeStripeProvider.listRefunds.bind(fakeStripeProvider);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    vi.spyOn(fakeStripeProvider, "listRefunds").mockImplementation(async (id: string) => {
      const live = await original(id);
      calls += 1;
      if (id === pi && calls === 1) {
        entered();
        await gate;
        return live;
      }
      return original(id);
    });
    return { entered: enteredGate, release };
  }

  it("a counted refund reversed between the resolution snapshot and commit is refused", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Stale underpay" },
    });
    const pi = `pi_stale_under_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "stale-under-cap");
    const counted = await fakeStripeProvider.refundPayment(pi, 400, "stale-under-ok");
    const failed = await fakeStripeProvider.refundPayment(pi, 600, "stale-under-fail");
    setRefundStatus(failed.refundId, "failed");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26511,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
        refundId: failed.refundId,
      },
    });
    const held = holdSecondRefundRead(pi);
    const resolving = resolveRefundFailed(order.id, "Paid 600 by Zelle", 600, 600);
    try {
      const winner = await Promise.race([
        held.entered.then(() => "held" as const),
        resolving.then(() => "done" as const),
      ]);
      expect(winner).toBe("held");
      setRefundStatus(counted.refundId, "failed");
      await applyProviderRefund({ ...counted, status: "failed", amountRefunded: 400, paymentIntentId: pi });
      held.release();
      expect(await resolving).toEqual({ ok: false, error: "balance changed, refresh" });
    } finally {
      held.release();
      vi.restoreAllMocks();
      setStripeProvider(fakeStripeProvider);
    }
    expect((await storeScoped(storeAId).order.findUnique({ where: { id: order.id } }))?.status).toBe("REFUND_FAILED");
    expect(await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_resolved_manually" },
    })).toBeNull();
  });

  it("a refund succeeding between the resolution snapshot and commit is refused", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Stale overpay" },
    });
    const pi = `pi_stale_over_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "stale-over-cap");
    const failed = await fakeStripeProvider.refundPayment(pi, 1000, "stale-over-fail");
    setRefundStatus(failed.refundId, "failed");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26512,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
        refundId: failed.refundId,
      },
    });
    const held = holdSecondRefundRead(pi);
    const resolving = resolveRefundFailed(order.id, "Paid 1000 by Zelle", 1000, 1000);
    try {
      const winner = await Promise.race([
        held.entered.then(() => "held" as const),
        resolving.then(() => "done" as const),
      ]);
      expect(winner).toBe("held");
      const late = await fakeStripeProvider.refundPayment(pi, 600, "stale-over-ok");
      await applyProviderRefund({ ...late, paymentIntentId: pi });
      held.release();
      expect(await resolving).toEqual({ ok: false, error: "balance changed, refresh" });
    } finally {
      held.release();
      vi.restoreAllMocks();
      setStripeProvider(fakeStripeProvider);
    }
    expect((await storeScoped(storeAId).order.findUnique({ where: { id: order.id } }))?.status).toBe("REFUND_FAILED");
    expect(await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_resolved_manually" },
    })).toBeNull();
  });

  it("a sweep-observed late success after manual resolution alerts overpayment", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Sweep late success" },
    });
    const pi = `pi_sweep_late_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "sweep-late-cap");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26513,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    const key = `refund:${order.id}:1`;
    await storeScoped(storeAId).refundRequest.create({
      data: {
        storeId: storeAId,
        orderId: order.id,
        paymentIntentId: pi,
        key,
        amountCents: 600,
        refundApplicationFee: true,
        state: "ABANDONED",
      },
    });
    expect(await resolveRefundFailed(order.id, "Paid 1000 by Zelle", 1000, 1000)).toEqual({ ok: true });
    setNextRefundStatus(pi, "pending");
    const late = await fakeStripeProvider.refundPayment(pi, 600, key, { reservationKey: key, orderId: order.id });
    setRefundStatus(late.refundId, "succeeded");
    const candidates = await findStuckTransitionalOrders();
    const selected = candidates.filter((row) => row.id === order.id);
    expect(selected).toHaveLength(1);
    for (const candidate of selected) await recordReconcileResult(candidate.storeId, candidate.id);
    const alert = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_after_manual_resolution" },
    });
    expect(alert?.after).toMatchObject({ overpaidCents: 600, refundId: late.refundId, alert: "store_and_platform" });
    expect((await storeScoped(storeAId).order.findUnique({ where: { id: order.id } }))?.status).toBe("CANCELLED");
    const matched = await storeScoped(storeAId).refundRequest.findFirst({ where: { orderId: order.id } });
    expect(matched?.state).toBe("CREATED");
    expect(matched?.providerStatus).toBe("succeeded");
    const again = await findStuckTransitionalOrders();
    for (const candidate of again.filter((row) => row.id === order.id)) {
      await recordReconcileResult(candidate.storeId, candidate.id);
    }
    const alerts = await storeScoped(storeAId).auditLog.findMany({
      where: { entityId: order.id, action: "refund_after_manual_resolution" },
    });
    expect(alerts).toHaveLength(1);
  });

  it("redelivering an already-counted success after manual resolution writes no alert", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Counted again" },
    });
    const pi = `pi_counted_again_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "counted-again-cap");
    const counted = await fakeStripeProvider.refundPayment(pi, 400, "counted-again-ok");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26514,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
        refundId: counted.refundId,
      },
    });
    expect(await resolveRefundFailed(order.id, "Paid 600 by Zelle", 600, 600)).toEqual({ ok: true });
    await applyProviderRefund({ ...counted, paymentIntentId: pi });
    expect(await storeScoped(storeAId).auditLog.count({
      where: { entityId: order.id, action: "refund_after_manual_resolution" },
    })).toBe(0);
  });

  it("a failure already counted before manual resolution writes no underpayment alert", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Already failed" },
    });
    const pi = `pi_already_failed_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "already-failed-cap");
    await fakeStripeProvider.refundPayment(pi, 400, "already-failed-ok");
    const failed = await fakeStripeProvider.refundPayment(pi, 600, "already-failed-no");
    setRefundStatus(failed.refundId, "failed");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26515,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
        refundId: failed.refundId,
      },
    });
    expect(await resolveRefundFailed(order.id, "Paid 600 by Zelle", 600, 600)).toEqual({ ok: true });
    await applyProviderRefund({ ...failed, status: "failed", paymentIntentId: pi });
    expect(await storeScoped(storeAId).auditLog.count({
      where: { entityId: order.id, action: "refund_reversed_after_resolution" },
    })).toBe(0);
  });

  it("two alerts never fire for the same balance change", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "One balance change" },
    });
    const pi = `pi_one_alert_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "one-alert-cap");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26516,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    expect(await resolveRefundFailed(order.id, "Paid 1000 by Zelle", 1000, 1000)).toEqual({ ok: true });
    const late = await fakeStripeProvider.refundPayment(pi, 600, "one-alert-late");
    await applyProviderRefund({ ...late, paymentIntentId: pi });
    await applyProviderRefund({ ...late, paymentIntentId: pi });
    expect(await storeScoped(storeAId).auditLog.count({
      where: { entityId: order.id, action: "refund_after_manual_resolution" },
    })).toBe(1);
  });

  it("an uncovered refund-failed order stays failed and stays on the sweep", async () => {
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Still uncovered" },
    });
    const pi = `pi_still_uncovered_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "still-uncovered-cap");
    const failed = await fakeStripeProvider.refundPayment(pi, 1000, "still-uncovered-fail");
    setRefundStatus(failed.refundId, "failed");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26601,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
        refundId: failed.refundId,
      },
    });
    const selected = (await findStuckTransitionalOrders()).filter((row) => row.id === order.id);
    expect(selected).toHaveLength(1);
    for (const candidate of selected) await recordReconcileResult(candidate.storeId, candidate.id);
    expect((await storeScoped(storeAId).order.findUnique({ where: { id: order.id } }))?.status).toBe("REFUND_FAILED");
  });

  it("a cancelled order with no abandoned request is not selected by the sweep", async () => {
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Quiet cancelled" },
    });
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26602,
        customerId: customer.id,
        status: "CANCELLED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
      },
    });
    expect((await findStuckTransitionalOrders()).some((row) => row.id === order.id)).toBe(false);
  });

  it("a late pending refund on an abandoned request does not alert", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Late still pending" },
    });
    const pi = `pi_late_pending_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "late-pending-cap");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26603,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    const key = `refund:${order.id}:1`;
    await storeScoped(storeAId).refundRequest.create({
      data: {
        storeId: storeAId,
        orderId: order.id,
        paymentIntentId: pi,
        key,
        amountCents: 600,
        refundApplicationFee: true,
        state: "ABANDONED",
      },
    });
    expect(await resolveRefundFailed(order.id, "Paid 1000 by Zelle", 1000, 1000)).toEqual({ ok: true });
    setNextRefundStatus(pi, "pending");
    const late = await fakeStripeProvider.refundPayment(pi, 600, key, { reservationKey: key, orderId: order.id });
    const selected = (await findStuckTransitionalOrders()).filter((row) => row.id === order.id);
    expect(selected).toHaveLength(1);
    for (const candidate of selected) await recordReconcileResult(candidate.storeId, candidate.id);
    expect(await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_after_manual_resolution" },
    })).toBeNull();
    const matched = await storeScoped(storeAId).refundRequest.findFirst({ where: { orderId: order.id } });
    expect(matched?.state).toBe("CREATED");
    expect(matched?.providerStatus).toBe("pending");
    expect(matched?.providerRefundId).toBe(late.refundId);
    expect((await storeScoped(storeAId).order.findUnique({ where: { id: order.id } }))?.status).toBe("CANCELLED");
  });

  it("an abandoned request with no provider refund is not sent again", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Nothing at the bank" },
    });
    const pi = `pi_abandoned_quiet_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "abandoned-quiet-cap");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26604,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    await storeScoped(storeAId).refundRequest.create({
      data: {
        storeId: storeAId,
        orderId: order.id,
        paymentIntentId: pi,
        key: `refund:${order.id}:1`,
        amountCents: 1000,
        refundApplicationFee: true,
        state: "ABANDONED",
      },
    });
    expect(await resolveRefundFailed(order.id, "Paid 1000 by Zelle", 1000, 1000)).toEqual({ ok: true });
    const sent = () => refundRequests.filter((request) => request.paymentIntentId === pi);
    expect(sent()).toHaveLength(0);
    const selected = (await findStuckTransitionalOrders()).filter((row) => row.id === order.id);
    expect(selected).toHaveLength(1);
    for (const candidate of selected) await recordReconcileResult(candidate.storeId, candidate.id);
    expect(sent()).toHaveLength(0);
    expect((await storeScoped(storeAId).refundRequest.findFirst({ where: { orderId: order.id } }))?.state).toBe("ABANDONED");
    expect(await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_after_manual_resolution" },
    })).toBeNull();
    expect((await storeScoped(storeAId).order.findUnique({ where: { id: order.id } }))?.status).toBe("CANCELLED");
  });

  it("a later distinct refund failure keeps its own audit and the admin failure date", async () => {
    asAdmin(cookiesAdmin);
    const sessionUser = await storeScopedTransaction(storeAId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ user: string }>>`SELECT session_user AS user`;
      return rows[0]?.user;
    });
    expect(sessionUser).toBe("app_runtime");
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Second failure" },
    });
    const pi = `pi_second_failure_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "second-failure-cap");
    const first = await fakeStripeProvider.refundPayment(pi, 1000, "second-failure-r1");
    setRefundStatus(first.refundId, "failed");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26610,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
        refundId: first.refundId,
      },
    });
    await storeScoped(storeAId).auditLog.create({
      data: {
        storeId: storeAId,
        actorId: adminId,
        actorEmail: emailAdmin,
        action: "refund_failed",
        entityType: "order",
        entityId: order.id,
        after: { refundId: first.refundId, refundStatus: "failed", alert: "store_and_platform" },
        createdAt: olderFailureAt,
      },
    });
    const second = await fakeStripeProvider.refundPayment(pi, 1000, "second-failure-r2");
    await evaluateOrderRefundState(order.id);
    expect((await storeScoped(storeAId).order.findUnique({ where: { id: order.id } }))?.status).toBe("CANCELLED");
    setRefundStatus(second.refundId, "failed");
    await applyProviderRefund({ ...second, status: "failed", paymentIntentId: pi });
    expect(await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: second.refundId,
      refundStatus: "failed",
    })).toEqual({ ok: true, action: "already_recorded" });
    const audits = await storeScoped(storeAId).auditLog.findMany({
      where: { entityId: order.id, action: "refund_failed" },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((row) => (row.after as { refundId?: string }).refundId)).toEqual([
      first.refundId,
      second.refundId,
    ]);
    const row = (await listRefundFailedOrders()).find((item) => item.orderId === order.id);
    expect(row?.failedRefundId).toBe(second.refundId);
    expect(row?.failedAtLabel).toBe(failedAtLabel(await secondAuditAt(storeAId, order.id, second.refundId), "America/Chicago"));
    await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: second.refundId,
      refundStatus: "failed",
    });
    expect(await storeScoped(storeAId).auditLog.count({
      where: { entityId: order.id, action: "refund_failed" },
    })).toBe(2);
    await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: first.refundId,
      refundStatus: "failed",
    });
    expect(await storeScoped(storeAId).auditLog.count({
      where: { entityId: order.id, action: "refund_failed" },
    })).toBe(2);
    const still = (await listRefundFailedOrders()).find((item) => item.orderId === order.id);
    expect(still?.failedRefundId).toBe(second.refundId);
    expect(still?.failedAtLabel).toBe(failedAtLabel(await secondAuditAt(storeAId, order.id, second.refundId), "America/Chicago"));
  });

  it("two uncovered failures found together each keep a record and the queue shows the newest", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Two failures" },
    });
    const pi = `pi_two_failures_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "two-failures-cap");
    const older = await fakeStripeProvider.refundPayment(pi, 400, "two-failures-old");
    setRefundStatus(older.refundId, "failed");
    const newer = await fakeStripeProvider.refundPayment(pi, 600, "two-failures-new");
    setRefundStatus(newer.refundId, "failed");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26611,
        customerId: customer.id,
        status: "CANCELLING",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    await evaluateOrderRefundState(order.id);
    const audits = await storeScoped(storeAId).auditLog.findMany({
      where: { entityId: order.id, action: "refund_failed" },
    });
    expect(audits.map((row) => (row.after as { refundId?: string }).refundId).sort()).toEqual(
      [older.refundId, newer.refundId].sort(),
    );
    const row = (await listRefundFailedOrders()).find((item) => item.orderId === order.id);
    expect(row?.failedRefundId).toBe(newer.refundId);
    expect((await storeScoped(storeAId).order.findUnique({ where: { id: order.id } }))?.status).toBe("REFUND_FAILED");
  });

  it("a failed refund that arrives while an older failure is already recorded replaces the queue date", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Out of order failure" },
    });
    const pi = `pi_ooo_failure_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "ooo-failure-cap");
    const first = await fakeStripeProvider.refundPayment(pi, 1000, "ooo-failure-r1");
    setRefundStatus(first.refundId, "failed");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26612,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
        refundId: first.refundId,
      },
    });
    await storeScoped(storeAId).auditLog.create({
      data: {
        storeId: storeAId,
        actorId: adminId,
        actorEmail: emailAdmin,
        action: "refund_failed",
        entityType: "order",
        entityId: order.id,
        after: { refundId: first.refundId, refundStatus: "failed", alert: "store_and_platform" },
        createdAt: olderFailureAt,
      },
    });
    const second = await fakeStripeProvider.refundPayment(pi, 1000, "ooo-failure-r2");
    setRefundStatus(second.refundId, "failed");
    await applyProviderRefund({ ...second, status: "failed", paymentIntentId: pi });
    expect(await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: second.refundId,
      refundStatus: "failed",
    })).toEqual({ ok: true, action: "already_recorded" });
    const row = (await listRefundFailedOrders()).find((item) => item.orderId === order.id);
    expect(row?.failedRefundId).toBe(second.refundId);
    expect(row?.failedAtLabel).toBe(failedAtLabel(await secondAuditAt(storeAId, order.id, second.refundId), "America/Chicago"));
    expect(await storeScoped(storeAId).auditLog.count({
      where: { entityId: order.id, action: "refund_failed" },
    })).toBe(2);
  });

  it("a refund landing between external repayment and submit records the submitted amount and alerts overpayment", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Paid then refunded" },
    });
    const pi = `pi_paid_then_refunded_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "paid-then-cap");
    const failed = await fakeStripeProvider.refundPayment(pi, 1000, "paid-then-fail");
    setRefundStatus(failed.refundId, "failed");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26620,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
        refundId: failed.refundId,
      },
    });
    const shown = (await listRefundFailedOrders()).find((row) => row.orderId === order.id);
    expect(shown?.owedCents).toBe(1000);
    await fakeStripeProvider.refundPayment(pi, 600, "paid-then-dashboard");
    const result = await resolveRefundFailed(order.id, "Paid 1000 cents by Zelle from displayed balance", 1000, shown!.owedCents);
    expect(result).toEqual({
      ok: true,
      message: "The balance changed since you loaded this page. An alert was recorded.",
    });
    const recorded = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_resolved_manually" },
    });
    expect(recorded?.after).toMatchObject({
      repaidCents: 1000,
      displayedOwedCents: 1000,
      refundedCents: 600,
      capturedCents: 1000,
    });
    const alert = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_after_manual_resolution" },
    });
    expect(alert?.after).toMatchObject({ overpaidCents: 600, alert: "store_and_platform" });
    await evaluateOrderRefundState(order.id);
    expect(await storeScoped(storeAId).auditLog.count({
      where: { entityId: order.id, action: "refund_after_manual_resolution" },
    })).toBe(1);
    expect((await storeScoped(storeAId).order.findUnique({ where: { id: order.id } }))?.status).toBe("CANCELLED");
  });

  it("submitting less than owed records an underpayment alert", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Paid less" },
    });
    const pi = `pi_paid_less_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "paid-less-cap");
    const failed = await fakeStripeProvider.refundPayment(pi, 1000, "paid-less-fail");
    setRefundStatus(failed.refundId, "failed");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26621,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
        refundId: failed.refundId,
      },
    });
    const result = await resolveRefundFailed(order.id, "Paid 400 by Zelle", 400, 1000);
    expect(result).toEqual({ ok: true });
    const recorded = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_resolved_manually" },
    });
    expect(recorded?.after).toMatchObject({ repaidCents: 400, refundedCents: 0, capturedCents: 1000 });
    const alert = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_reversed_after_resolution" },
    });
    expect(alert?.after).toMatchObject({ underpaidCents: 600, alert: "store_and_platform" });
    expect((await storeScoped(storeAId).order.findUnique({ where: { id: order.id } }))?.status).toBe("CANCELLED");
  });

  it("an edited amount that meets the new balance does not claim an alert", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Edited to match" },
    });
    const pi = `pi_edited_match_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "edited-cap");
    const failed = await fakeStripeProvider.refundPayment(pi, 1000, "edited-fail");
    setRefundStatus(failed.refundId, "failed");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26624,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
        refundId: failed.refundId,
      },
    });
    await fakeStripeProvider.refundPayment(pi, 600, "edited-dashboard");
    const result = await resolveRefundFailed(order.id, "Paid the remaining 400", 400, 1000);
    expect(result).toEqual({ ok: true, message: "The balance changed since you loaded this page." });
    expect(await storeScoped(storeAId).auditLog.count({
      where: {
        entityId: order.id,
        action: { in: ["refund_after_manual_resolution", "refund_reversed_after_resolution"] },
      },
    })).toBe(0);
  });

  it("repaidCents outside 1..C or non-integer is rejected", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Bad amount" },
    });
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26622,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
      },
    });
    for (const repaidCents of [0, 1001, 12.5]) {
      const result = await resolveRefundFailed(order.id, "Paid something", repaidCents, 1000);
      expect(result.ok).toBe(false);
    }
    const empty = new FormData();
    empty.set("orderId", order.id);
    empty.set("note", "Paid something");
    empty.set("repaidDollars", "");
    empty.set("displayedOwedCents", "1000");
    const missing = await resolveRefundFailedAction(null, empty);
    expect(missing.ok).toBe(false);
    expect((await storeScoped(storeAId).order.findUnique({ where: { id: order.id } }))?.status).toBe("REFUND_FAILED");
  });

  it("the form posts the prefilled dollars as cents", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Form cents" },
    });
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26623,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 2500,
        bufferCents: 0,
        totalAuthorizedCents: 2500,
        totalCents: 2500,
        capturedAmountCents: 2500,
      },
    });
    const form = new FormData();
    form.set("orderId", order.id);
    form.set("note", "Paid customer by Zelle");
    form.set("repaidDollars", (2500 / 100).toFixed(2));
    form.set("displayedOwedCents", "2500");
    expect(await resolveRefundFailedAction(null, form)).toEqual({ ok: true });
    const recorded = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_resolved_manually" },
    });
    expect(recorded?.after).toMatchObject({ repaidCents: 2500, displayedOwedCents: 2500, capturedCents: 2500 });
  });

  it("an active replay cannot be repaid when it crosses the abandon boundary", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Replay in flight" },
    });
    const pi = `pi_replay_inflight_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "replay-cap");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26625,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    const key = `refund:${order.id}:1`;
    const stored = await storeScoped(storeAId).refundRequest.create({
      data: {
        storeId: storeAId,
        orderId: order.id,
        paymentIntentId: pi,
        key,
        amountCents: 1000,
        refundApplicationFee: true,
        state: "UNKNOWN",
        createdAt: new Date(Date.now() - REFUND_REQUEST_ABANDON_MS + 5_000),
      },
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = fakeStripeProvider.refundPayment.bind(fakeStripeProvider);
    const spy = vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const now = Date.now();
    const replay = reconcileRefundRequest(stored);
    try {
      await enteredGate;
      vi.spyOn(Date, "now").mockReturnValue(now + 10_000);
      const result = await resolveRefundFailed(order.id, "Repaid 1000 outside app", 1000, 1000);
      expect(result.ok).toBe(false);
    } finally {
      release();
      await replay;
      spy.mockRestore();
      vi.spyOn(Date, "now").mockRestore();
      setStripeProvider(fakeStripeProvider);
    }

    expect(await storeScoped(storeAId).auditLog.count({
      where: { entityId: order.id, action: "refund_resolved_manually" },
    })).toBe(0);
    expect(await storeScoped(storeAId).auditLog.count({
      where: { entityId: order.id, action: "refund_after_manual_resolution" },
    })).toBe(0);
    const listed = await fakeStripeProvider.listRefunds(pi);
    expect(listed.filter((refund) => refund.status === "succeeded")).toHaveLength(1);
    expect(listed[0]?.amountRefunded).toBe(1000);
  });

  it("a replay reserved on another server cannot be repaid or abandoned", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Other server replay" },
    });
    const pi = `pi_other_server_replay_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "other-server-cap");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26626,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    const key = `refund:${order.id}:1`;
    await storeScoped(storeAId).refundRequest.create({
      data: {
        storeId: storeAId,
        orderId: order.id,
        paymentIntentId: pi,
        key,
        amountCents: 400,
        refundApplicationFee: true,
        state: "REPLAYING",
        createdAt: new Date(Date.now() - REFUND_REQUEST_ABANDON_MS - 5_000),
        lastCheckedAt: new Date(),
      },
    });
    const result = await resolveRefundFailed(order.id, "Repaid the rest", 600, 1000);
    expect(result.ok).toBe(false);
    const stored = await storeScoped(storeAId).refundRequest.findFirst({ where: { key } });
    expect(stored?.state).toBe("REPLAYING");
    expect(await fakeStripeProvider.listRefunds(pi)).toHaveLength(0);
    expect(await storeScoped(storeAId).auditLog.count({
      where: { entityId: order.id, action: "refund_resolved_manually" },
    })).toBe(0);
  });

  it("review186 stale reader must not abandon a newly reserved live replay", async () => {
    asAdmin(cookiesAdmin);
    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Race repayment" },
    });
    const pi = `pi_stale_replay_${RUN}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "race-cap");
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 26630,
        customerId: customer.id,
        status: "REFUND_FAILED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const key = `refund:${order.id}:1`;
    const stale = await storeScoped(storeAId).refundRequest.create({
      data: {
        storeId: storeAId,
        orderId: order.id,
        paymentIntentId: pi,
        key,
        amountCents: 1000,
        refundApplicationFee: true,
        state: "UNKNOWN",
        createdAt: new Date(now - REFUND_REQUEST_ABANDON_MS + 5000),
      },
    });
    let releaseList!: () => void;
    let listEntered!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const listStarted = new Promise<void>((resolve) => {
      listEntered = resolve;
    });
    let releaseRefund!: () => void;
    let refundEntered!: () => void;
    const refundGate = new Promise<void>((resolve) => {
      releaseRefund = resolve;
    });
    const refundStarted = new Promise<void>((resolve) => {
      refundEntered = resolve;
    });
    const originalList = fakeStripeProvider.listRefunds.bind(fakeStripeProvider);
    const originalRefund = fakeStripeProvider.refundPayment.bind(fakeStripeProvider);
    let lists = 0;
    const listSpy = vi.spyOn(fakeStripeProvider, "listRefunds").mockImplementation(async (id) => {
      if (id === pi && ++lists === 1) {
        listEntered();
        await listGate;
        return [];
      }
      return originalList(id);
    });
    const refundSpy = vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async (...args) => {
      refundEntered();
      await refundGate;
      return originalRefund(...args);
    });
    const staleReader = reconcileRefundRequest(stale);
    try {
      await listStarted;
      const replay = reconcileRefundRequest(stale);
      await refundStarted;
      const leased = await storeScoped(storeAId).refundRequest.findUniqueOrThrow({ where: { id: stale.id } });
      expect(leased.state).toBe("REPLAYING");
      clearReplayCallsForTests();
      clock.mockReturnValue(now + 10000);
      releaseList();
      await staleReader;
      const abandoned = await storeScoped(storeAId).refundRequest.findUniqueOrThrow({ where: { id: stale.id } });
      expect(abandoned.state).toBe("REPLAYING");
      const result = await resolveRefundFailed(order.id, "Paid 1000 outside app while replay live", 1000, 1000);
      releaseRefund();
      await replay;
      expect(result.ok, "Manual repayment must be refused while another server has a live refund call").toBe(false);
      expect(await storeScoped(storeAId).auditLog.count({
        where: { entityId: order.id, action: "refund_resolved_manually" },
      })).toBe(0);
      const refunds = await originalList(pi);
      expect(refunds.filter((refund) => refund.status === "succeeded")).toEqual([
        expect.objectContaining({ amountRefunded: 1000 }),
      ]);
    } finally {
      releaseList();
      releaseRefund();
      await staleReader.catch(() => {});
      listSpy.mockRestore();
      refundSpy.mockRestore();
      clock.mockRestore();
      setStripeProvider(fakeStripeProvider);
    }
  });
});
