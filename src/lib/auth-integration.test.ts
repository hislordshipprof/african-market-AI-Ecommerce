import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { auth } from "./auth";
import { authPrisma, storeScoped } from "./db";
import { findOrCreateCustomer } from "./customer-auth";
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
  if (!html) throw new Error("No email sent");
  const match = html.match(/href="([^"]+)"/);
  if (!match) throw new Error("No href in email HTML");
  return match[1].replace(/&amp;/g, "&");
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
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, 'Integ Test Store', ${storeSlug}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${staffUserId}, 'staff', now())`;
    });
  });

  afterAll(async () => {
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE store_id = ${storeId}`;
      const emails = [customerEmail, staffEmail, adminEmail];
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
    expect((await before.json()).session).toBeTruthy();

    const signedOut = await authPost("/sign-out", {}, cookies);
    expect(signedOut.status).toBeLessThan(400);
    const after = await authGet(`${BASE}/get-session`, collectCookies(signedOut));
    const body = await after.json();
    expect(body?.session ?? null).toBeNull();
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

      await expect(
        storeScoped(storeId).customer.create({
          data: {
            storeId: store2Id,
            userId: user!.id,
            name: "illegal",
            email: customerEmail,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await authPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        await tx.$executeRaw`DELETE FROM customers WHERE store_id IN (${storeId}, ${store2Id})`;
        await tx.$executeRaw`DELETE FROM stores WHERE id = ${store2Id}`;
      });
    }
  });
});
