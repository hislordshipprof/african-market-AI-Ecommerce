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
import { authPrisma, platformSessionUser, storeScoped, storeScopedTransaction } from "../db";
import { setStripeProvider } from "../stripe";
import { fakeStripeProvider, reset, setAuthorizedAmount, setNextRefundStatus, setRefundStatus } from "../stripe/fake";
import { autoCancelOrder, markTerminalRefundFailure, reconcileStuckOrder } from "../order/service";
import { listRefundFailedOrders, resolveRefundFailed } from "./refund-resolution";

const BASE = "http://localhost:3000/api/auth";
const RUN = `t264-${Date.now()}`;
const password = "RefundResolve-186!";
const hasDb = !!process.env.DATABASE_URL;

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
    await expect(resolveRefundFailed(orderId, "owner tried")).rejects.toSatisfy((error: unknown) => {
      return isRedirectError(error) && getURLFromRedirectError(error) === "/admin/sign-in";
    });
    const after = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe("REFUND_FAILED");
  });

  it("an admin without 2FA cannot resolve", async () => {
    asAdmin(cookiesBare);
    await expect(resolveRefundFailed(orderId, "no second factor")).rejects.toSatisfy((error: unknown) => {
      return isRedirectError(error) && getURLFromRedirectError(error) === "/admin/enroll-2fa";
    });
    const after = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe("REFUND_FAILED");
  });

  it("signed-out callers cannot resolve", async () => {
    headerState.delete("cookie");
    await expect(resolveRefundFailed(orderId, "signed out")).rejects.toSatisfy((error: unknown) => {
      return isRedirectError(error) && getURLFromRedirectError(error) === "/admin/sign-in";
    });
    const after = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe("REFUND_FAILED");
  });

  it("an empty, whitespace or 501-character note is refused", async () => {
    asAdmin(cookiesAdmin);
    for (const note of ["", "   ", "x".repeat(501)]) {
      const result = await resolveRefundFailed(orderId, note);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.fieldError).toMatch(/1–500/);
    }
    const after = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe("REFUND_FAILED");
    const note = "x".repeat(500);
    const accepted = await resolveRefundFailed(orderId, note);
    expect(accepted).toEqual({ ok: true });
    const resolved = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(resolved?.status).toBe("CANCELLED");
    expect(resolved?.notes).toBe(note);
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.order.update({
        where: { id: orderId },
        data: { status: "REFUND_FAILED", notes: null, cancelledAt: null },
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
    const result = await resolveRefundFailed(orderId, "Paid customer by Zelle 11/05");
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
        data: { status: "REFUND_FAILED", notes: null, cancelledAt: null },
      });
      await tx.auditLog.deleteMany({ where: { entityId: orderId, action: "refund_resolved_manually" } });
    });
  });

  it("a platform admin resolves a refund-failed order with a note", async () => {
    asAdmin(cookiesAdmin);
    const result = await resolveRefundFailed(orderId, "Paid customer by Zelle 11/05");
    expect(result).toEqual({ ok: true });
    const updated = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(updated?.status).toBe("CANCELLED");
    expect(updated?.notes).toBe("Paid customer by Zelle 11/05");
    const audit = await storeScoped(storeAId).auditLog.findFirst({
      where: { entityId: orderId, action: "refund_resolved_manually" },
    });
    expect(audit?.actorId).toBe(adminId);
    expect(audit?.after).toMatchObject({ note: "Paid customer by Zelle 11/05", alert: "store" });
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.order.update({
        where: { id: orderId },
        data: { status: "REFUND_FAILED", notes: null, cancelledAt: null },
      });
      await tx.auditLog.deleteMany({ where: { entityId: orderId, action: "refund_resolved_manually" } });
    });
  });

  it("two concurrent resolves write one transition and one audit row", async () => {
    expect(cookiesAdmin2).toContain("better-auth");
    headerQueue.push(new Headers({ cookie: cookiesAdmin }), new Headers({ cookie: cookiesAdmin2 }));
    const [first, second] = await Promise.all([
      resolveRefundFailed(orderId, "first admin"),
      resolveRefundFailed(orderId, "second admin"),
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
    const result = await resolveRefundFailed(target.id, "Repaid store A only");
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
      expect(await resolveRefundFailed(order.id, "Paid customer by Zelle")).toEqual({ ok: true });
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
      expect(await resolveRefundFailed(order.id, "Paid customer by Zelle")).toEqual({ ok: true });
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

    expect(await resolveRefundFailed(order.id, "Paid customer by Zelle")).toEqual({ ok: true });
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
    const result = await resolveRefundFailed(order.id, "Paid displayed 1000 cents by Zelle");
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
    expect((await resolveRefundFailed(order.id, "Too early")).ok).toBe(false);
    setRefundStatus(pending!.refundId, "succeeded");
    const queue = (await listRefundFailedOrders()).find((row) => row.orderId === order.id);
    expect(queue?.bankRefundPending).toBe(false);
    expect(queue?.owedCents).toBe(400);
    expect(await resolveRefundFailed(order.id, "Paid the remaining 400 cents by Zelle")).toEqual({ ok: true });
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
      setRefundStatus(older.refundId, "failed");
      const webhook = await markTerminalRefundFailure({
        paymentIntentId: pi,
        refundId: older.refundId,
        refundStatus: "failed",
      });
      const queue = (await listRefundFailedOrders()).find((row) => row.orderId === order.id);
      const manual = await resolveRefundFailed(order.id, "Paid displayed 1000 cents by Zelle");
      expect(webhook).toEqual({ ok: true, action: "refund_failed" });
      expect(queue?.owedCents).toBe(1000);
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
    const result = await resolveRefundFailed(order.id, "Customer repaid outside app");
    const stored = await storeScoped(storeAId).order.findUnique({ where: { id: order.id } });
    expect(result).toEqual({ ok: true });
    expect(stored?.status).toBe("CANCELLED");
  });
});
