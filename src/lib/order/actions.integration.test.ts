import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

vi.mock("next/headers", () => ({
  headers: async () => headerState,
}));

const bucket = vi.hoisted(() => new Map<string, Uint8Array>());
const bucketReads = vi.hoisted(() => [] as string[]);
vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    constructor(readonly input: { Key: string; Body: Uint8Array }) {}
  }
  class GetObjectCommand {
    constructor(readonly input: { Key: string }) {}
  }
  class S3Client {
    async send(command: PutObjectCommand | GetObjectCommand) {
      if (command instanceof PutObjectCommand) {
        bucket.set(command.input.Key, command.input.Body);
        return {};
      }
      bucketReads.push(command.input.Key);
      const body = bucket.get(command.input.Key);
      if (!body) throw new Error("NoSuchKey");
      return { Body: { transformToWebStream: () => new Blob([new Uint8Array(body)]).stream() }, ContentType: "image/jpeg" };
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand };
});

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
}));

import { Prisma } from "@prisma/client";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { generateTOTP } from "../../../e2e/totp";
import { auth } from "../auth";
import { authPrisma, platformSessionUser, storeScoped, storeScopedTransaction } from "../db";
import { setStripeProvider } from "../stripe";
import { cancelledPayments, fakeStripeProvider, refundRequests, setAuthorizedAmount } from "../stripe/fake";
import { issuePhotoKey } from "../r2";
import { systemAuditData } from "../system-actor";
import { GET as getIssuePhoto } from "../../app/api/issue-photo/[issueId]/route";
import {
  approveIssueAction,
  cancelOrderAction,
  completePickupAction,
  declineIssueAction,
  markDeliveredAction,
  markOutForDeliveryAction,
  markReadyAction,
} from "./actions";
import { issuesToReview } from "./issue-review";
import { acceptOrder, markLinePicked, markLineShort } from "./service";
import { countedListing, placeOrder, stockOf } from "./stock-ledger-test-helpers";
import sharp from "sharp";

const BASE = "http://localhost:3000/api/auth";
const RUN = `t186-${Date.now()}`;
const password = "StaffIso-186!";
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

async function deliveredForm(orderId: string): Promise<FormData> {
  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#c0392b" } }).jpeg().toBuffer();
  const form = new FormData();
  form.set("orderId", orderId);
  form.set("photo", new File([new Uint8Array(jpeg)], "delivery.jpg", { type: "image/jpeg" }));
  return form;
}

function asStore(slug: string, cookies: string): void {
  headerState.set("cookie", cookies);
  headerState.set("x-store-slug", slug);
}

async function signInWithTwoFactor(email: string): Promise<string> {
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

describe.skipIf(!hasDb)("staff order actions (real auth.handler, lane DB)", () => {
  const storeAId = crypto.randomUUID();
  const storeBId = crypto.randomUUID();
  const storeASlug = `a-${RUN}`;
  const storeBSlug = `b-${RUN}`;
  const emailA = `owner-a-${RUN}@example.com`;
  const emailB = `owner-b-${RUN}@example.com`;
  let ownerAId = "";
  let ownerBId = "";
  let cookiesA = "";
  let cookiesB = "";
  let orderId = "";
  let auditId = "";

  beforeAll(async () => {
    expect(await platformSessionUser()).toBe("app_runtime");

    for (const [email, name] of [
      [emailA, "Owner A"],
      [emailB, "Owner B"],
    ] as const) {
      const res = await authPost("/sign-up/email", { email, password, name });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    ownerAId = (await authPrisma.user.findFirstOrThrow({ where: { email: emailA } })).id;
    ownerBId = (await authPrisma.user.findFirstOrThrow({ where: { email: emailB } })).id;

    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeAId}, ${"Store A " + RUN}, ${storeASlug}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeBId}, ${"Store B " + RUN}, ${storeBSlug}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeAId}, ${ownerAId}, 'owner', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeBId}, ${ownerBId}, 'owner', now())`;
    });

    setStripeProvider(fakeStripeProvider);
    cookiesA = await signInWithTwoFactor(emailA);
    cookiesB = await signInWithTwoFactor(emailB);

    const customer = await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "A Customer" },
    });
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number: 186,
        customerId: customer.id,
        status: "AWAITING_PICKUP",
        fulfillment: "pickup",
        subtotalCents: 1200,
        bufferCents: 120,
        totalAuthorizedCents: 1320,
        totalCents: 1200,
        capturedAmountCents: 1200,
        paymentIntentId: `pi_${RUN}`,
      },
    });
    orderId = order.id;
    const audit = await storeScoped(storeAId).auditLog.create({
      data: {
        storeId: storeAId,
        actorId: ownerAId,
        actorEmail: emailA,
        action: "seed_marker",
        entityType: "order",
        entityId: order.id,
      },
    });
    auditId = audit.id;
  }, 60_000);

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    setStripeProvider(null);
    const emails = [emailA, emailB];
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM stock_events WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM cart_lines WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM carts WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM notification_logs WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM issue_reports WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM refund_requests WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM order_lines WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM orders WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM customers WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM listing_variants WHERE listing_id IN (SELECT id FROM listings WHERE store_id IN (${storeAId}, ${storeBId}))`;
      await tx.$executeRaw`DELETE FROM listings WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE store_id IN (${storeAId}, ${storeBId})`;
      const found = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE email IN (${Prisma.join(emails)})
      `;
      const userIds = [...new Set([ownerAId, ownerBId, ...found.map((row) => row.id)].filter(Boolean))];
      if (userIds.length > 0) {
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id IN (${Prisma.join(userIds)})`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id IN (${Prisma.join(userIds)})`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id IN (${Prisma.join(userIds)})`;
        await tx.$executeRaw`DELETE FROM verifications WHERE identifier LIKE ${"%" + RUN + "%"} OR value LIKE ${"%" + RUN + "%"}`;
        await tx.$executeRaw`DELETE FROM users WHERE id IN (${Prisma.join(userIds)})`;
      }
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${storeAId}, ${storeBId})`;
    });
  });

  it("staff of another store cannot mark ready, complete or cancel this store's order; nobody cancels after capture", async () => {
    const before = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(before?.status).toBe("AWAITING_PICKUP");
    expect(await storeScoped(storeBId).order.findUnique({ where: { id: orderId } })).toBeNull();
    const crossed = await storeScoped(storeBId).order.updateMany({
      where: { id: orderId },
      data: { status: "COMPLETED" },
    });
    expect(crossed.count).toBe(0);
    await expect(
      storeScopedTransaction(storeBId, (tx) =>
        tx.auditLog.create({
          data: {
            storeId: storeAId,
            actorId: ownerBId,
            actorEmail: emailB,
            action: "cross_store",
            entityType: "order",
            entityId: orderId,
          },
        }),
      ),
    ).rejects.toThrow();

    asStore(storeBSlug, cookiesB);
    vi.stubEnv("R2_PROOF_BUCKET", "proof-bucket");
    const ready = await markReadyAction(orderId);
    const pickup = await completePickupAction(orderId);
    const crossCancel = await cancelOrderAction(orderId, { reason: "other" });
    const sentOut = await markOutForDeliveryAction(orderId);
    const delivered = await markDeliveredAction(await deliveredForm(orderId));
    expect(ready).toEqual({ ok: false, error: "Order not found" });
    expect(pickup).toEqual({ ok: false, error: "Order not found" });
    expect(crossCancel).toEqual({ ok: false, error: "Order not found" });
    expect(sentOut).toEqual({ ok: false, error: "Order not found" });
    expect(delivered).toEqual({ ok: false, error: "Order not found" });
    expect([...bucket.keys()].some((key) => key.startsWith("delivery-proof/"))).toBe(false);

    // Store A's own staff cannot cancel after capture either: that is a refund, not a cancel.
    asStore(storeASlug, cookiesA);
    expect(await cancelOrderAction(orderId, { reason: "store_closed" })).toEqual({
      ok: false,
      error: "Cannot cancel order in status AWAITING_PICKUP",
    });

    const after = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe("AWAITING_PICKUP");
    expect(after?.completedAt).toBeNull();
    expect(after?.cancelledAt).toBeNull();
    expect(cancelledPayments.has(`pi_${RUN}`)).toBe(false);
    const audit = await storeScoped(storeAId).auditLog.findUnique({ where: { id: auditId } });
    expect(audit?.action).toBe("seed_marker");
    expect(await storeScoped(storeAId).auditLog.count({ where: { entityId: orderId } })).toBe(1);
  });

  it("a signed-out request redirects to the store sign-in", async () => {
    headerState.delete("cookie");
    headerState.set("x-store-slug", storeASlug);
    const toSignIn = (error: unknown) =>
      isRedirectError(error) && getURLFromRedirectError(error) === `/store-admin/sign-in?store=${storeASlug}`;
    await expect(markReadyAction(orderId)).rejects.toSatisfy(toSignIn);
    await expect(markOutForDeliveryAction(orderId)).rejects.toSatisfy(toSignIn);
    await expect(markDeliveredAction(await deliveredForm(orderId))).rejects.toSatisfy(toSignIn);
    const after = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe("AWAITING_PICKUP");
  });

  it("staff cancel a picking order: hold voided, stock returned once, audit names them, customer told", async () => {
    const picked = await countedListing(storeAId, 10, "Picked");
    const shorted = await countedListing(storeAId, 10, "Shorted");
    const placed = await placeOrder(storeAId, [
      { variantId: picked.variantId, qty: 3 },
      { variantId: shorted.variantId, qty: 2 },
    ]);
    await acceptOrder(storeAId, placed.orderId, 15);
    const lines = await storeScoped(storeAId).orderLine.findMany({ where: { orderId: placed.orderId } });
    const pickedLine = lines.find((line) => line.qtyOrdered === 3)!;
    const shortLine = lines.find((line) => line.qtyOrdered === 2)!;
    expect((await markLinePicked(storeAId, pickedLine.id)).ok).toBe(true);
    expect((await markLineShort(storeAId, shortLine.id, 1)).ok).toBe(true);

    asStore(storeASlug, cookiesA);
    const cancelled = await cancelOrderAction(placed.orderId, { reason: "out_of_stock", note: "Freezer broke" });
    expect(cancelled).toEqual({ ok: true });

    const order = await storeScoped(storeAId).order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(order.status).toBe("CANCELLED");
    expect(cancelledPayments.has(placed.paymentIntentId)).toBe(true);
    expect(await stockOf(storeAId, picked.listingId)).toEqual({
      qty: 10,
      events: [["reservation", -3], ["reservation_release", 3]],
    });
    // The short already gave back one unit and wrote one off; the cancel returns the unit still held.
    expect(await stockOf(storeAId, shorted.listingId)).toEqual({
      qty: 9,
      events: [["reservation", -2], ["reservation_release", 1], ["short", -1], ["reservation_release", 1]],
    });
    const audits = await storeScoped(storeAId).auditLog.findMany({
      where: { entityId: placed.orderId, entityType: "order", action: "store_cancel" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: ownerAId, actorEmail: emailA });
    expect(audits[0]?.after).toMatchObject({ reason: "out_of_stock", note: "Freezer broke" });
    const told = await storeScoped(storeAId).notificationLog.findMany({
      where: { orderId: placed.orderId, event: "cancelled" },
    });
    expect(told.length).toBeGreaterThan(0);
  }, 30_000);

  /** A completed pickup order captured at `capturedCents`, with an in-review issue of `issueCents`. */
  async function issueToReview(number: number, capturedCents: number, issueCents: number) {
    const customer = await storeScoped(storeAId).customer.create({ data: { storeId: storeAId, name: `Issue ${number}` } });
    const pi = `pi_issue_${number}_${RUN}`;
    setAuthorizedAmount(pi, capturedCents);
    await fakeStripeProvider.capturePaymentIntent(pi, capturedCents, `cap-issue-${number}-${RUN}`);
    const order = await storeScoped(storeAId).order.create({
      data: {
        storeId: storeAId,
        number,
        customerId: customer.id,
        status: "COMPLETED",
        fulfillment: "pickup",
        subtotalCents: capturedCents,
        bufferCents: 0,
        totalAuthorizedCents: capturedCents,
        totalCents: capturedCents,
        capturedAmountCents: capturedCents,
        paymentIntentId: pi,
        completedAt: new Date(),
      },
    });
    const issueId = `iss${number}${Date.now()}`;
    const photoKey = issuePhotoKey(order.id, issueId);
    bucket.set(photoKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    await storeScoped(storeAId).issueReport.create({
      data: { id: issueId, storeId: storeAId, orderId: order.id, type: "damaged", lines: [], photoKey, amountCents: issueCents, state: "in_review" },
    });
    return { orderId: order.id, issueId, pi };
  }

  async function reviewed(orderId: string) {
    const scoped = storeScoped(storeAId);
    return {
      order: await scoped.order.findUniqueOrThrow({ where: { id: orderId } }),
      issue: await scoped.issueReport.findUniqueOrThrow({ where: { orderId } }),
      requests: await scoped.refundRequest.findMany({ where: { orderId } }),
      audits: await scoped.auditLog.findMany({ where: { entityId: orderId, action: { startsWith: "issue_" } } }),
    };
  }

  it("the owner approves $15 of a $60 issue: one $15 refund, issue approved, order Partly refunded, audit names the owner", async () => {
    const { orderId, issueId } = await issueToReview(601, 8000, 6000);
    asStore(storeASlug, cookiesA);
    expect(await approveIssueAction(issueId, 1500)).toEqual({ ok: true });
    const after = await reviewed(orderId);
    expect(after.requests.map((row) => row.amountCents)).toEqual([1500]);
    expect(after.issue.state).toBe("approved");
    expect(after.issue.refundRequestId).toBe(after.requests[0]!.id);
    expect(after.order.status).toBe("PARTIALLY_REFUNDED");
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({ action: "issue_approved", actorId: ownerAId, actorEmail: emailA });
    expect(after.audits[0]!.after).toMatchObject({ issueReportId: issueId, amountCents: 1500 });
  }, 30_000);

  it("a decline with a reason calls no Stripe, leaves the order and writes one audit row", async () => {
    const { orderId, issueId, pi } = await issueToReview(602, 8000, 6000);
    asStore(storeASlug, cookiesA);
    expect(await declineIssueAction(issueId, "  ")).toEqual({ ok: false, error: "Write why you are declining" });
    expect(await declineIssueAction(issueId, "Photo shows a different product")).toEqual({ ok: true });
    const after = await reviewed(orderId);
    expect(refundRequests.some((call) => call.paymentIntentId === pi)).toBe(false);
    expect(after.requests).toHaveLength(0);
    expect(after.issue.state).toBe("declined");
    expect(after.order.status).toBe("COMPLETED");
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({ action: "issue_declined", actorId: ownerAId });
    expect(after.audits[0]!.after).toMatchObject({ reason: "Photo shows a different product" });
  }, 30_000);

  it("two approve clicks at once create exactly one refund request", async () => {
    const { orderId, issueId, pi } = await issueToReview(603, 8000, 6000);
    asStore(storeASlug, cookiesA);
    const results = await Promise.all([approveIssueAction(issueId), approveIssueAction(issueId)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const after = await reviewed(orderId);
    expect(after.requests.map((row) => row.amountCents)).toEqual([6000]);
    expect(refundRequests.filter((call) => call.paymentIntentId === pi)).toHaveLength(1);
    expect(after.audits.filter((row) => row.action === "issue_approved")).toHaveLength(1);
  }, 30_000);

  it("staff of store B can neither approve store A's issue nor view its photo; signed out sees no photo", async () => {
    const { orderId, issueId, pi } = await issueToReview(604, 8000, 6000);
    const photo = (id: string) => getIssuePhoto(new Request(`http://localhost/api/issue-photo/${id}`), { params: Promise.resolve({ issueId: id }) });

    vi.stubEnv("R2_ACCOUNT_ID", "test-account");
    vi.stubEnv("R2_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret");
    vi.stubEnv("R2_PROOF_BUCKET", "proof-bucket");
    asStore(storeBSlug, cookiesB);
    bucketReads.length = 0;
    expect(await approveIssueAction(issueId)).toEqual({ ok: false, error: "Problem not found" });
    expect(await declineIssueAction(issueId, "Not ours")).toEqual({ ok: false, error: "Problem not found" });
    const crossed = await photo(issueId);
    expect(crossed.status).toBe(404);
    expect(bucketReads).toEqual([]);

    headerState.delete("cookie");
    headerState.set("x-store-slug", storeASlug);
    await expect(photo(issueId)).rejects.toSatisfy((error: unknown) => isRedirectError(error));
    expect(bucketReads).toEqual([]);

    const after = await reviewed(orderId);
    expect(after.issue.state).toBe("in_review");
    expect(after.requests).toHaveLength(0);
    expect(after.audits).toHaveLength(0);
    expect(refundRequests.some((call) => call.paymentIntentId === pi)).toBe(false);

    asStore(storeASlug, cookiesA);
    const own = await photo(issueId);
    vi.unstubAllEnvs();
    expect(own.status).toBe(200);
    expect(own.headers.get("Cache-Control")).toBe("private, no-store");
  }, 30_000);

  it("an approval Stripe refuses tells staff it failed and marks the issue refund_failed, not Refund sent", async () => {
    const { orderId, issueId } = await issueToReview(608, 8000, 6000);
    vi.spyOn(fakeStripeProvider, "refundPayment").mockRejectedValue(
      Object.assign(new Error("charge is disputed"), { type: "StripeInvalidRequestError", statusCode: 400, code: "charge_disputed" }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    asStore(storeASlug, cookiesA);
    expect(await approveIssueAction(issueId)).toEqual({
      ok: false,
      error: "The refund did not go through. The platform has been alerted; do not refund the customer yourself.",
    });
    const after = await reviewed(orderId);
    expect(after.issue.state).toBe("refund_failed");
    expect(after.order.status).toBe("COMPLETED");
    expect(after.audits.map((row) => row.action).sort()).toEqual(["issue_approved", "issue_refund_failed"]);
  }, 30_000);

  it("an approval whose refund cannot start puts the issue back in review with the attempt on record", async () => {
    const { orderId, issueId, pi } = await issueToReview(609, 8000, 6000);
    await storeScoped(storeAId).auditLog.create({ data: systemAuditData(storeAId, orderId, "refund_resolved_manually") });
    asStore(storeASlug, cookiesA);
    expect(await approveIssueAction(issueId)).toEqual({ ok: false, error: "The refund could not be started. Try again." });
    const after = await reviewed(orderId);
    expect(after.issue).toMatchObject({ state: "in_review", amountCents: 6000, refundRequestId: null });
    expect(after.requests).toHaveLength(0);
    expect(refundRequests.some((call) => call.paymentIntentId === pi)).toBe(false);
    expect(after.audits.map((row) => row.action).sort()).toEqual(["issue_approval_not_started", "issue_approved"]);
  }, 30_000);

  it("an issue stranded approved or auto-refunded with no refund request returns to review and can be approved", async () => {
    const stale = await issueToReview(606, 8000, 6000);
    const fresh = await issueToReview(607, 8000, 6000);
    const longAgo = new Date(Date.now() - 20 * 60 * 1000);
    // A crash between the claim and the refund reservation leaves exactly this row.
    await storeScoped(storeAId).issueReport.update({ where: { id: stale.issueId }, data: { state: "auto_refunded", updatedAt: longAgo } });
    await storeScoped(storeAId).issueReport.update({ where: { id: fresh.issueId }, data: { state: "approved" } });
    const listed = (await issuesToReview(storeAId)).map((issue) => issue.id);
    expect(listed).toContain(stale.issueId);
    expect(listed).not.toContain(fresh.issueId);

    asStore(storeASlug, cookiesA);
    expect(await approveIssueAction(fresh.issueId)).toEqual({ ok: false, error: "This problem was already handled" });
    expect(await approveIssueAction(stale.issueId)).toMatchObject({ ok: true });
    const after = await reviewed(stale.orderId);
    expect(after.requests.map((row) => row.amountCents)).toEqual([6000]);
    expect(after.issue).toMatchObject({ state: "approved", refundRequestId: after.requests[0]!.id });
  }, 30_000);

  it("a partial amount above the remaining capture is refused with an allow-listed message", async () => {
    const { orderId, issueId, pi } = await issueToReview(605, 8000, 6000);
    await fakeStripeProvider.refundPayment(pi, 7000, `earlier-${RUN}`);
    asStore(storeASlug, cookiesA);
    expect(await approveIssueAction(issueId, 1500)).toEqual({
      ok: false,
      error: "That is more than is left to refund on this order ($10.00).",
    });
    const after = await reviewed(orderId);
    expect(after.issue.state).toBe("in_review");
    expect(after.requests).toHaveLength(0);
    expect(after.audits).toHaveLength(0);
  }, 30_000);
});
