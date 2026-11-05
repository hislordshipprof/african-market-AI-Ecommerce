import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

import { Prisma } from "@prisma/client";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { generateTOTP } from "../../../e2e/totp";
import { auth } from "../auth";
import { authPrisma, platformSessionUser, storeScoped, storeScopedTransaction } from "../db";
import { completePickupAction, markReadyAction } from "./actions";

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

function asStore(slug: string, cookies: string): void {
  headerState.set("cookie", cookies);
  headerState.set("x-store-slug", slug);
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

    const jar = new CookieJar();
    const signedIn = await authPost("/sign-in/email", { email: emailB, password });
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
    cookiesB = jar.header();

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

  afterAll(async () => {
    const emails = [emailA, emailB];
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM orders WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM customers WHERE store_id IN (${storeAId}, ${storeBId})`;
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

  it("staff of another store cannot mark ready or complete this store's order", async () => {
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
    const ready = await markReadyAction(orderId);
    const pickup = await completePickupAction(orderId);
    expect(ready).toEqual({ ok: false, error: "Order not found" });
    expect(pickup).toEqual({ ok: false, error: "Order not found" });

    const after = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe("AWAITING_PICKUP");
    expect(after?.completedAt).toBeNull();
    const audit = await storeScoped(storeAId).auditLog.findUnique({ where: { id: auditId } });
    expect(audit?.action).toBe("seed_marker");
    expect(await storeScoped(storeAId).auditLog.count({ where: { entityId: orderId } })).toBe(1);
  });

  it("a signed-out request redirects to the store sign-in", async () => {
    headerState.delete("cookie");
    headerState.set("x-store-slug", storeASlug);
    await expect(markReadyAction(orderId)).rejects.toSatisfy((error: unknown) => {
      return isRedirectError(error) && getURLFromRedirectError(error) === `/store-admin/sign-in?store=${storeASlug}`;
    });
    const after = await storeScoped(storeAId).order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe("AWAITING_PICKUP");
  });
});
