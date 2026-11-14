import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
}));
import { NextRequest } from "next/server";
import { auth, resolveAuthTrustedOrigins } from "./auth";
import { GET as authRouteGET, POST as authRoutePOST } from "@/app/api/auth/[...all]/route";
import { authPrisma, storeScoped } from "./db";
import { Client } from "pg";
import { findOrCreateCustomer } from "./customer-auth";
import { resolveDirectUrl } from "./env";
import { verifyUrlFromEmail } from "./test-magic-link";
import { customerRlsErrorText, isCustomerRlsRejection } from "./customer-rls-error";
import { syncCustomerForStore } from "./customer-claim";
import { listAccountOrders } from "./customer-account/order-history";
import {
  getTestSentEmails,
  clearTestSentEmails,
  setEmailSenderForTests,
  type EmailMessage,
} from "./email/send";

const BASE = "http://localhost:3000/api/auth";
const suffix = Date.now();

async function authPost(
  path: string,
  body: unknown,
  cookies?: string,
  extra?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extra,
  };
  if (cookies) headers.cookie = cookies;
  return auth.handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

async function authGet(
  url: string,
  cookies?: string,
  extra?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { ...extra };
  if (cookies) headers.cookie = cookies;
  return auth.handler(new Request(url, { headers, redirect: "manual" }));
}

function collectCookies(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).join("; ");
}

function extractVerifyUrl(html = getTestSentEmails().at(-1)?.html): string {
  const url = verifyUrlFromEmail(html);
  if (!url) throw new Error("No sign-in link in the email");
  return url;
}

async function latestMagicLink(email: string): Promise<{ token: string; id: string } | null> {
  const rows = await authPrisma.verification.findMany({
    where: { identifier: { startsWith: "magic-link:" } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const row = rows.find((item) => item.value.includes(email));
  if (!row) return null;
  return { id: row.id, token: row.identifier.replace(/^magic-link:/, "") };
}

describe("auth integration (real DB, app_runtime)", () => {
  const customerEmail = `integ-customer-${suffix}@test.example`;
  const staffEmail = `integ-staff-${suffix}@test.example`;
  const adminEmail = `integ-admin-${suffix}@test.example`;
  const storeSlug = `integ-store-${suffix}`;
  const storeDomain = `shop-${suffix}.integ.example`;
  const adaEmail = `ada-claim-${suffix}@example.com`;
  const unprovenEmail = `unproven-claim-${suffix}@example.com`;

  let storeId: string;
  let staffUserId: string;

  beforeAll(async () => {
    // Sign up three users through auth handler (creates users + credential accounts)
    for (const [email, name] of [
      [customerEmail, "Integ Customer"],
      [staffEmail, "Integ Staff"],
      [adminEmail, "Integ Admin"],
    ] as const) {
      const res = await authPost("/sign-up/email", {
        email,
        password: "IntegPass-123!",
        name,
      });
      expect(res.status).toBe(200);
    }

    // Promote admin user
    await authPrisma.user.updateMany({
      where: { email: adminEmail },
      data: { role: "admin" },
    });

    // Get staff user ID
    const staffUser = await authPrisma.user.findFirst({
      where: { email: staffEmail },
      select: { id: true },
    });
    staffUserId = staffUser!.id;

    // Create a test store and staff membership (platform admin context for RLS)
    storeId = crypto.randomUUID();
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, custom_domain, status, updated_at) VALUES (${storeId}, 'Integ Test Store', ${storeSlug}, ${storeDomain}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${staffUserId}, 'staff', now())`;
    });
  });

  afterAll(async () => {
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE store_id = ${storeId}`;
      const emails = [
        customerEmail,
        staffEmail,
        adminEmail,
        `integ-unknown-${suffix}@test.example`,
        adaEmail,
        unprovenEmail,
      ];
      for (const email of emails) {
        await tx.$executeRaw`DELETE FROM customers WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM verifications WHERE identifier = ${email} OR value LIKE ${"%" + email + "%"}`;
        await tx.$executeRaw`DELETE FROM users WHERE email = ${email}`;
      }
      await tx.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
    });
  });

  beforeEach(() => {
    clearTestSentEmails();
    setEmailSenderForTests(null);
  });

  it("sends magic link email to plain customer", async () => {
    const res = await authPost("/sign-in/magic-link", {
      email: customerEmail,
      callbackURL: "/account",
    });
    expect(res.status).toBe(200);
    expect(getTestSentEmails().length).toBe(1);
    expect(getTestSentEmails()[0].to).toBe(customerEmail);
  });

  it("suppresses magic link email for admin user (K1 role check)", async () => {
    const res = await authPost("/sign-in/magic-link", {
      email: adminEmail,
      callbackURL: "/account",
    });
    expect(res.status).toBe(200);
    expect(getTestSentEmails().length).toBe(0);
  });

  it("suppresses magic link email for staff with store membership (K1 RLS)", async () => {
    const res = await authPost("/sign-in/magic-link", {
      email: staffEmail,
      callbackURL: "/account",
    });
    expect(res.status).toBe(200);
    expect(getTestSentEmails().length).toBe(0);
  });

  it("magic-link verify creates session for plain customer", async () => {
    await authPost("/sign-in/magic-link", {
      email: customerEmail,
      callbackURL: "/account",
    });
    expect(getTestSentEmails().length).toBe(1);

    const verifyUrl = extractVerifyUrl();
    const verifyRes = await authGet(verifyUrl);
    expect(verifyRes.status).toBeLessThan(400);

    const cookies = collectCookies(verifyRes);
    expect(cookies).toContain("better-auth.session_token");
  });

  it("magic-link verify blocked for user with membership (K1 session hook + RLS)", async () => {
    // Get a valid magic link token for the staff user by temporarily removing their membership
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE store_id = ${storeId} AND user_id = ${staffUserId}`;
    });

    // Now request magic link (should send because user is currently a plain customer)
    const res = await authPost("/sign-in/magic-link", {
      email: staffEmail,
      callbackURL: "/account",
    });
    expect(res.status).toBe(200);
    expect(getTestSentEmails().length).toBe(1);
    const verifyUrl = extractVerifyUrl();

    // Restore membership before verify
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${staffUserId}, 'staff', now())`;
    });

    // Verify should now fail because session.create.before sees the membership via platformAdmin
    const verifyRes = await authGet(verifyUrl);
    const body = await verifyRes.json().catch(() => null);
    expect(verifyRes.status).toBe(403);
    expect(body?.message ?? body?.error).toMatch(/staff/i);
  });

  it("magic-link session does NOT have twoFactorVerified (conditional hook)", async () => {
    await authPost("/sign-in/magic-link", {
      email: customerEmail,
      callbackURL: "/account",
    });
    expect(getTestSentEmails().length).toBe(1);

    const verifyUrl = extractVerifyUrl();
    const verifyRes = await authGet(verifyUrl);
    expect(verifyRes.status).toBeLessThan(400);

    const cookies = collectCookies(verifyRes);
    expect(cookies).toContain("better-auth.session_token");

    const sessionRes = await authGet(`${BASE}/get-session`, cookies);
    expect(sessionRes.status).toBe(200);
    const body = await sessionRes.json();
    expect(body.session.twoFactorVerified).toBe(false);
  });

  it("handler responds before a slow sender resolves, and a rejection is logged without the address", async () => {
    let release: (error: Error) => void = () => {};
    const gate = new Promise<never>((_, reject) => {
      release = reject;
    });
    let started = false;
    setEmailSenderForTests({
      async send() {
        started = true;
        await gate;
        return { id: "never" };
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await authPost("/sign-in/magic-link", {
      email: customerEmail,
      callbackURL: "/account",
    });

    expect(started).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: true });
    expect(errorSpy).not.toHaveBeenCalled();

    release(new Error(`smtp down for ${customerEmail}`));
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    });
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("magic_link_delivery_failed");
    expect(logged).toContain("[redacted]");
    expect(logged).not.toContain(customerEmail);
    errorSpy.mockRestore();
  });

  it("E4: staff, unknown, and customer magic-link responses match and return before a slow sender", async () => {
    const unknownEmail = `integ-unknown-${suffix}@test.example`;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recorded: EmailMessage[] = [];
    setEmailSenderForTests({
      async send(message) {
        await gate;
        recorded.push(message);
        return { id: "slow" };
      },
    });

    const results: Array<{ status: number; body: unknown }> = [];
    for (const email of [staffEmail, unknownEmail, customerEmail]) {
      const res = await authPost(
        "/sign-in/magic-link",
        { email, callbackURL: "/account" },
        undefined,
        { "x-store-slug": storeSlug },
      );
      results.push({ status: res.status, body: await res.json() });
    }

    expect(recorded).toHaveLength(0);
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect(results[0]).toEqual({ status: 200, body: { status: true } });

    release();
    await vi.waitFor(() => {
      expect(recorded.length).toBeGreaterThan(0);
    });
  });

  it("magic-link email uses the store name, not the platform name", async () => {
    const res = await authPost(
      "/sign-in/magic-link",
      { email: customerEmail, callbackURL: "/account" },
      undefined,
      { "x-store-slug": storeSlug, host: `${storeSlug}.localhost:3000` },
    );
    expect(res.status).toBe(200);
    const message = getTestSentEmails().at(-1);
    expect(message?.subject).toBe("Sign in to Integ Test Store");
    expect(message?.html).toContain("Integ Test Store");
    expect(message?.html).not.toContain("African Markets");
    expect(message?.from).toContain("Integ Test Store");
  });

  it("magic-link email on a store's custom domain uses the store name", async () => {
    const res = await authPost(
      "/sign-in/magic-link",
      { email: customerEmail, callbackURL: "/account" },
      undefined,
      { "x-custom-domain": storeDomain, host: storeDomain },
    );
    expect(res.status).toBe(200);
    expect(getTestSentEmails().at(-1)?.subject).toBe("Sign in to Integ Test Store");
  });

  it("a shopper on a store's custom domain can sign in by magic link", async () => {
    const origin = `http://${storeDomain}`;
    const onDomain = { "x-custom-domain": storeDomain, host: storeDomain, origin };
    const res = await authPost(
      "/sign-in/magic-link",
      { email: customerEmail, callbackURL: "/account" },
      undefined,
      onDomain,
    );
    expect(res.status).toBe(200);

    const link = new URL(extractVerifyUrl());
    expect(link.origin).toBe(origin);
    expect(link.pathname).toBe("/api/auth/magic-link/verify");

    const verifyRes = await authRouteGET(
      new NextRequest(link, { headers: onDomain, redirect: "manual" }),
    );
    expect(collectCookies(verifyRes)).toContain("session_token");
    const location = verifyRes.headers.get("location") ?? "";
    expect(new URL(location, origin).origin).toBe(origin);
  });

  it("trusts a registered store's custom-domain origin and no other domain", async () => {
    const trusted = auth.options.trustedOrigins as (request?: Request) => Promise<string[]>;
    const onHost = (domain: string) =>
      new Request(`http://${domain}/api/auth/sign-in/magic-link`, {
        headers: { "x-custom-domain": domain },
      });
    expect(await trusted(onHost(storeDomain))).toContain(`http://${storeDomain}`);
    const stranger = `shop-${suffix}.unregistered.example`;
    expect((await trusted(onHost(stranger))).join(",")).not.toContain(stranger);
    expect(await trusted()).toEqual(resolveAuthTrustedOrigins());
  });

  it("an unregistered custom domain gets no customer sign-in", async () => {
    const stranger = `shop-${suffix}.unregistered.example`;
    const res = await authRoutePOST(
      new NextRequest(`http://${stranger}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-custom-domain": stranger, host: stranger },
        body: JSON.stringify({ email: customerEmail, callbackURL: "/account" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(getTestSentEmails()).toHaveLength(0);
  });

  it("E5: an expired magic link does not create a session", async () => {
    await authPost("/sign-in/magic-link", {
      email: customerEmail,
      callbackURL: "/account",
    });
    const link = await latestMagicLink(customerEmail);
    expect(link).toBeTruthy();
    await authPrisma.verification.update({
      where: { id: link!.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const verifyRes = await authGet(
      `${BASE}/magic-link/verify?token=${link!.token}&callbackURL=/account`,
    );
    expect(verifyRes.status).toBeGreaterThanOrEqual(300);
    expect(verifyRes.headers.get("location")).toContain("INVALID_TOKEN");
    expect(collectCookies(verifyRes)).not.toContain("session_token");
  });

  it("E5: a used magic link fails on the second use", async () => {
    await authPost("/sign-in/magic-link", {
      email: customerEmail,
      callbackURL: "/account",
    });
    const verifyUrl = extractVerifyUrl();
    const first = await authGet(verifyUrl);
    expect(collectCookies(first)).toContain("session_token");

    const second = await authGet(verifyUrl);
    expect(second.headers.get("location") ?? "").toContain("INVALID_TOKEN");
    expect(collectCookies(second)).not.toContain("session_token");
  });

  it("E8: sign-out ends the session", async () => {
    await authPost("/sign-in/magic-link", {
      email: customerEmail,
      callbackURL: "/account",
    });
    const verifyRes = await authGet(extractVerifyUrl());
    const cookies = collectCookies(verifyRes);
    const before = await authGet(`${BASE}/get-session`, cookies);
    const beforeBody = await before.json();
    expect(beforeBody.session).toBeTruthy();
    const sessionId = beforeBody.session.id as string;

    const signedOut = await authPost("/sign-out", {}, cookies);
    expect(signedOut.status).toBeLessThan(400);
    const afterSignOut = await authGet(`${BASE}/get-session`, cookies);
    const body = await afterSignOut.json();
    expect(body?.session ?? null).toBeNull();
    expect(await authPrisma.session.findUnique({ where: { id: sessionId } })).toBeNull();
  });

  it("a first-time magic-link sign-in creates the account, syncs a nameless Customer, and the name fills in", async () => {
    const email = `integ-new-${suffix}@test.example`;
    const host = `${storeSlug}.localhost:3000`;
    try {
      const sent = await authPost(
        "/sign-in/magic-link",
        { email, callbackURL: "/account" },
        undefined,
        { "x-store-slug": storeSlug, host },
      );
      expect(sent.status).toBe(200);
      expect(await authPrisma.user.count({ where: { email } })).toBe(0);
      const verifyUrl = extractVerifyUrl();
      expect(new URL(verifyUrl).host).toBe(host);
      const verified = await authGet(verifyUrl, undefined, { host, "x-store-slug": storeSlug });
      const cookies = collectCookies(verified);
      expect(cookies).toContain("session_token");

      const user = await sessionUserFrom(cookies);
      expect(user).toMatchObject({ email, name: "", emailVerified: true });
      expect((await syncCustomerForStore(storeId, user)).name).toBe("");

      await auth.api.updateUser({ headers: new Headers({ cookie: cookies }), body: { name: "Ngozi Okafor" } });
      const renamed = await syncCustomerForStore(storeId, await sessionUserFrom(cookies));
      expect(renamed.name).toBe("Ngozi Okafor");
      const rows = await storeScoped(storeId).customer.findMany({ where: { userId: user.id } });
      expect(rows.map((row) => row.name)).toEqual(["Ngozi Okafor"]);
    } finally {
      await authPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        await tx.$executeRaw`DELETE FROM customers WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM verifications WHERE value LIKE ${"%" + email + "%"}`;
        await tx.$executeRaw`DELETE FROM users WHERE email = ${email}`;
      });
    }
  });

  it("E6/AC4: two store-host sign-ins sync one user, two sessions, and two isolated customers", async () => {
    const store2Id = crypto.randomUUID();
    const store2Slug = `integ-store2-${suffix}`;
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${store2Id}, 'Integ Store 2', ${store2Slug}, 'active', now())`;
      await tx.$executeRaw`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${customerEmail})`;
      await tx.$executeRaw`DELETE FROM customers WHERE user_id IN (SELECT id FROM users WHERE email = ${customerEmail})`;
    });

    try {
      const sessionIds: string[] = [];
      let user: { id: string; name: string; email: string } | null = null;

      for (const [slug, id] of [
        [storeSlug, storeId],
        [store2Slug, store2Id],
      ] as const) {
        clearTestSentEmails();
        const sent = await authPost(
          "/sign-in/magic-link",
          { email: customerEmail, callbackURL: "/account" },
          undefined,
          { "x-store-slug": slug, host: `${slug}.localhost:3000` },
        );
        expect(sent.status).toBe(200);
        expect(new URL(extractVerifyUrl()).host).toBe(`${slug}.localhost:3000`);
        const verifyRes = await authGet(extractVerifyUrl(), undefined, {
          host: `${slug}.localhost:3000`,
          "x-store-slug": slug,
        });
        const cookies = collectCookies(verifyRes);
        expect(cookies).toContain("session_token");
        const sessionRes = await authGet(`${BASE}/get-session`, cookies);
        const sessionBody = await sessionRes.json();
        expect(sessionBody.user.email).toBe(customerEmail);
        sessionIds.push(sessionBody.session.id);
        user = sessionBody.user;
        await findOrCreateCustomer(id, sessionBody.user);
      }

      expect(new Set(sessionIds).size).toBe(2);
      const users = await authPrisma.user.findMany({ where: { email: customerEmail } });
      expect(users).toHaveLength(1);
      const sessions = await authPrisma.session.findMany({
        where: { id: { in: sessionIds } },
      });
      expect(sessions).toHaveLength(2);
      expect(sessions.every((row) => row.userId === users[0].id)).toBe(true);

      const rowsA = await storeScoped(storeId).customer.findMany({
        where: { userId: user!.id },
      });
      const rowsB = await storeScoped(store2Id).customer.findMany({
        where: { userId: user!.id },
      });
      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
      expect(rowsA[0].storeId).toBe(storeId);
      expect(rowsB[0].storeId).toBe(store2Id);
      expect(rowsA[0].id).not.toBe(rowsB[0].id);

      const crossRead = await storeScoped(storeId).customer.findMany({
        where: { id: rowsB[0].id },
      });
      expect(crossRead).toHaveLength(0);

      const crossWrite = await storeScoped(storeId).customer.updateMany({
        where: { id: rowsB[0].id },
        data: { name: "cross-store write" },
      });
      expect(crossWrite.count).toBe(0);
      const untouched = await storeScoped(store2Id).customer.findFirst({
        where: { id: rowsB[0].id },
      });
      expect(untouched?.name).not.toBe("cross-store write");

      // A user with no store-2 row, so only RLS (not the unique index) can reject it.
      const stranger = await authPrisma.user.findFirstOrThrow({ where: { email: adminEmail } });
      const illegal = await storeScoped(storeId)
        .customer.create({
          data: { storeId: store2Id, userId: stranger.id, name: "illegal", email: adminEmail },
        })
        .then(() => null, (error: unknown) => error);
      expect(isCustomerRlsRejection(illegal), customerRlsErrorText(illegal)).toBe(true);
    } finally {
      await authPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        await tx.$executeRaw`DELETE FROM customers WHERE store_id IN (${storeId}, ${store2Id})`;
        await tx.$executeRaw`DELETE FROM stores WHERE id = ${store2Id}`;
      });
    }
  });

  it(
    "concurrent first customer syncs recover a real uniqueness conflict and remain isolated by store",
    async () => {
      const stamp = crypto.randomUUID().slice(0, 8);
      const email = `integ-race-${stamp}@test.example`;
      const storeA = crypto.randomUUID();
      const storeB = crypto.randomUUID();
      const slugA = `integ-race-a-${stamp}`;
      const slugB = `integ-race-b-${stamp}`;
      const signedUp = await authPost("/sign-up/email", {
        email,
        password: "IntegPass-123!",
        name: "Race Customer",
      });
      expect(signedUp.status, await signedUp.clone().text()).toBe(200);
      const signedBody = (await signedUp.json()) as {
        user: { id: string; name: string; email: string };
      };
      const user = {
        id: signedBody.user.id,
        name: signedBody.user.name,
        email: signedBody.user.email,
      };
      const client = new Client({ connectionString: resolveDirectUrl() });
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        try {
          await client.query("ROLLBACK");
        } catch {
          // The lock transaction is already closed.
        }
        try {
          await client.end();
        } catch {
          // The client is already closed.
        }
      };

      try {
        await authPrisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL ROLE app_user`;
          await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
          await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeA}, 'Race A', ${slugA}, 'active', now())`;
          await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeB}, 'Race B', ${slugB}, 'active', now())`;
        });
        const atStoreB = await findOrCreateCustomer(storeB, user);
        await client.connect();
        await client.query("BEGIN");
        await client.query("LOCK TABLE customers IN SHARE MODE");
        let waiting = 0;
        const pending = Promise.all([
          findOrCreateCustomer(storeA, user),
          findOrCreateCustomer(storeA, user),
        ]);
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          const locks = await client.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_locks WHERE relation = 'public.customers'::regclass AND NOT granted",
          );
          waiting = Number(locks.rows[0]?.n ?? 0);
          if (waiting >= 2) break;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        await client.query("COMMIT");
        await client.end();
        released = true;
        const [left, right] = await pending;
        expect(waiting, "both first syncs blocked on insert").toBeGreaterThanOrEqual(2);
        expect(left.id).toBe(right.id);
        expect(left.id).not.toBe(atStoreB.id);
        expect(left).toMatchObject({ name: "Race Customer", email });
        expect(right).toMatchObject({ name: "Race Customer", email });

        const rowsA = await storeScoped(storeA).customer.findMany({ where: { userId: user.id } });
        const rowsB = await storeScoped(storeB).customer.findMany({ where: { userId: user.id } });
        expect(rowsA).toHaveLength(1);
        expect(rowsB).toHaveLength(1);
        expect(rowsA[0].id).toBe(left.id);
        expect(rowsB[0].id).toBe(atStoreB.id);
        expect(rowsA[0].storeId).toBe(storeA);
        expect(rowsB[0].storeId).toBe(storeB);

        const crossRead = await storeScoped(storeA).customer.findMany({ where: { id: atStoreB.id } });
        expect(crossRead).toHaveLength(0);
        const crossWrite = await storeScoped(storeA).customer.updateMany({
          where: { id: atStoreB.id },
          data: { name: "cross-store write" },
        });
        expect(crossWrite.count).toBe(0);
        const untouched = await storeScoped(storeB).customer.findFirst({ where: { id: atStoreB.id } });
        expect(untouched?.name).toBe("Race Customer");
      } finally {
        await release();
        await authPrisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL ROLE app_user`;
          await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
          await tx.$executeRaw`DELETE FROM customers WHERE store_id IN (${storeA}, ${storeB})`;
          await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${user.id}`;
          await tx.$executeRaw`DELETE FROM accounts WHERE user_id = ${user.id}`;
          await tx.$executeRaw`DELETE FROM verifications WHERE value LIKE ${"%" + email + "%"} OR value = ${user.id}`;
          await tx.$executeRaw`DELETE FROM users WHERE id = ${user.id}`;
          await tx.$executeRaw`DELETE FROM stores WHERE id IN (${storeA}, ${storeB})`;
        });
      }
    },
    30_000,
  );
  async function sessionUserFrom(cookies: string) {
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookies }),
      query: { disableCookieCache: true },
    });
    if (!session) throw new Error("No session for cookies");
    return session.user;
  }

  async function seedGuestOrder(
    store: string,
    input: { number: number; email: string; name: string; phone: string; createdAt: Date },
  ) {
    const db = storeScoped(store);
    const guest = await db.customer.create({
      data: { storeId: store, name: input.name, email: input.email, phone: input.phone },
    });
    const order = await db.order.create({
      data: {
        storeId: store,
        number: input.number,
        customerId: guest.id,
        status: "AUTHORIZED",
        subtotalCents: 1000 + input.number,
        tipCents: 200,
        bufferCents: 100,
        totalAuthorizedCents: 1300 + input.number,
        createdAt: input.createdAt,
      },
    });
    return { guestId: guest.id, orderId: order.id };
  }

  // Claimed guest rows point at the account Customer (ON DELETE RESTRICT): delete orders, then guests, then the rest.
  async function deleteClaimFixtures(storeIds: string[]) {
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      for (const id of storeIds) {
        await tx.$executeRaw`DELETE FROM orders WHERE store_id = ${id}`;
        await tx.$executeRaw`DELETE FROM customers WHERE store_id = ${id} AND claimed_by_customer_id IS NOT NULL`;
        await tx.$executeRaw`DELETE FROM customers WHERE store_id = ${id}`;
      }
    });
  }

  it("magic-link sign-in claims this store's guest orders by verified email, once, and nothing else", async () => {
    const storeBId = crypto.randomUUID();
    const storeBSlug = `integ-claim-b-${suffix}`;
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeBId}, 'Integ Claim B', ${storeBSlug}, 'active', now())`;
    });
    const hour = 60 * 60 * 1000;
    const now = Date.now();
    try {
      const first = await seedGuestOrder(storeId, {
        number: 1, email: adaEmail, name: "Ada Guest", phone: "+15550001001", createdAt: new Date(now - 3 * hour),
      });
      const second = await seedGuestOrder(storeId, {
        number: 2, email: adaEmail, name: "Ada O.", phone: "+15550001002", createdAt: new Date(now - 2 * hour),
      });
      const bob = await seedGuestOrder(storeId, {
        number: 3, email: `bob-claim-${suffix}@example.com`, name: "Bob", phone: "+15550001003", createdAt: new Date(now - hour),
      });
      const atB = await seedGuestOrder(storeBId, {
        number: 1, email: adaEmail, name: "Ada at B", phone: "+15550001004", createdAt: new Date(now - hour),
      });
      const ordersBefore = await storeScoped(storeId).order.findMany({
        where: { id: { in: [first.orderId, second.orderId] } },
        include: { customer: { select: { name: true, phone: true, email: true } } },
        orderBy: { number: "asc" },
      });

      const mixedCase = adaEmail.replace("ada-claim", "Ada-Claim").replace("example.com", "Example.COM");
      const sent = await authPost(
        "/sign-in/magic-link",
        { email: mixedCase, callbackURL: "/account" },
        undefined,
        { "x-store-slug": storeSlug, host: `${storeSlug}.localhost:3000` },
      );
      expect(sent.status).toBe(200);
      const verifyRes = await authGet(extractVerifyUrl(), undefined, {
        host: `${storeSlug}.localhost:3000`,
        "x-store-slug": storeSlug,
      });
      const user = await sessionUserFrom(collectCookies(verifyRes));

      const account = await syncCustomerForStore(storeId, user);
      const linkedAfterFirst = await storeScoped(storeId).customer.findMany({
        where: { claimedByCustomerId: account.id },
        orderBy: { id: "asc" },
      });
      expect(linkedAfterFirst.map((row) => row.id).sort()).toEqual([first.guestId, second.guestId].sort());
      expect(linkedAfterFirst.every((row) => row.claimedAt instanceof Date)).toBe(true);

      const again = await syncCustomerForStore(storeId, user);
      expect(again.id).toBe(account.id);
      const linkedAfterSecond = await storeScoped(storeId).customer.findMany({
        where: { claimedByCustomerId: account.id },
        orderBy: { id: "asc" },
      });
      expect(linkedAfterSecond.map((row) => [row.id, row.claimedAt?.getTime()])).toEqual(
        linkedAfterFirst.map((row) => [row.id, row.claimedAt?.getTime()]),
      );

      const bobRow = await storeScoped(storeId).customer.findFirst({ where: { id: bob.guestId } });
      expect(bobRow?.claimedByCustomerId).toBeNull();
      const bRowBefore = await storeScoped(storeBId).customer.findFirst({ where: { id: atB.guestId } });
      expect(bRowBefore?.claimedByCustomerId).toBeNull();

      const direct = await storeScoped(storeId).order.create({
        data: {
          storeId, number: 4, customerId: account.id, status: "COMPLETED", subtotalCents: 500,
          bufferCents: 50, totalAuthorizedCents: 550, capturedAmountCents: 480, createdAt: new Date(now),
        },
      });
      const history = await listAccountOrders(storeId, account.id);
      expect(history.map((row) => row.id)).toEqual([direct.id, second.orderId, first.orderId]);

      const ordersAfter = await storeScoped(storeId).order.findMany({
        where: { id: { in: [first.orderId, second.orderId] } },
        include: { customer: { select: { name: true, phone: true, email: true } } },
        orderBy: { number: "asc" },
      });
      expect(ordersAfter).toEqual(ordersBefore);

      const accountB = await syncCustomerForStore(storeBId, user);
      expect(accountB.id).not.toBe(account.id);
      const bRowAfter = await storeScoped(storeBId).customer.findFirst({ where: { id: atB.guestId } });
      expect(bRowAfter?.claimedByCustomerId).toBe(accountB.id);
      expect((await listAccountOrders(storeBId, accountB.id)).map((row) => row.id)).toEqual([atB.orderId]);
      expect(await listAccountOrders(storeId, accountB.id)).toEqual([]);
    } finally {
      await deleteClaimFixtures([storeId, storeBId]);
      await authPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        await tx.$executeRaw`DELETE FROM stores WHERE id = ${storeBId}`;
      });
    }
  });

  it("an account whose email is not proven claims nothing", async () => {
    try {
      const guest = await seedGuestOrder(storeId, {
        number: 11, email: unprovenEmail, name: "Real Owner", phone: "+15550001011", createdAt: new Date(),
      });
      const signUp = await authPost("/sign-up/email", {
        email: unprovenEmail,
        password: "IntegPass-123!",
        name: "Squatter",
      });
      expect(signUp.status).toBe(200);
      const user = await sessionUserFrom(collectCookies(signUp));
      expect(user.emailVerified).toBe(false);

      const account = await syncCustomerForStore(storeId, user);

      const row = await storeScoped(storeId).customer.findFirst({ where: { id: guest.guestId } });
      expect(row?.claimedByCustomerId).toBeNull();
      expect(row?.claimedAt).toBeNull();
      expect(await listAccountOrders(storeId, account.id)).toEqual([]);
    } finally {
      await deleteClaimFixtures([storeId]);
    }
  });
});
