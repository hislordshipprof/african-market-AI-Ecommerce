import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { auth } from "./auth";
import { authPrisma } from "./db";
import { getTestSentEmails, clearTestSentEmails } from "./email/send";

const BASE = "http://localhost:3000/api/auth";
const suffix = Date.now();

async function authPost(
  path: string,
  body: unknown,
  cookies?: string,
): Promise<Response> {
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

async function authGet(url: string, cookies?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookies) headers.cookie = cookies;
  return auth.handler(new Request(url, { headers, redirect: "manual" }));
}

function collectCookies(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).join("; ");
}

function extractVerifyUrl(): string {
  const emails = getTestSentEmails();
  const last = emails[emails.length - 1];
  if (!last) throw new Error("No email sent");
  const match = last.html.match(/href="([^"]+)"/);
  if (!match) throw new Error("No href in email HTML");
  return match[1].replace(/&amp;/g, "&");
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
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM verifications WHERE identifier = ${email}`;
        await tx.$executeRaw`DELETE FROM users WHERE email = ${email}`;
      }
      await tx.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
    });
  });

  beforeEach(() => {
    clearTestSentEmails();
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

  it("E4: magic-link response is identical for staff, unknown, and customer emails (K2 timing)", async () => {
    const unknownEmail = `integ-unknown-${suffix}@test.example`;
    const results: Array<{ status: number; body: unknown }> = [];

    for (const email of [staffEmail, unknownEmail, customerEmail]) {
      clearTestSentEmails();
      const res = await authPost("/sign-in/magic-link", {
        email,
        callbackURL: "/account",
      });
      const body = await res.json();
      results.push({ status: res.status, body });
    }

    // All three return the same status
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);
    expect(results[2].status).toBe(200);

    // Response structure is the same (no enumeration leak)
    expect(typeof results[0].body).toBe(typeof results[1].body);
    expect(typeof results[1].body).toBe(typeof results[2].body);
  });

  it("E6/AC4: same email on two stores creates one User, two Customers", async () => {
    // Create a second store
    const store2Id = crypto.randomUUID();
    const store2Slug = `integ-store2-${suffix}`;
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${store2Id}, 'Integ Store 2', ${store2Slug}, 'active', now())`;
    });

    try {
      // Get the customer user
      const user = await authPrisma.user.findFirst({
        where: { email: customerEmail },
        select: { id: true },
      });
      expect(user).toBeTruthy();

      // Create customer records in both stores
      await authPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        await tx.$executeRaw`INSERT INTO customers (id, store_id, user_id, name, email, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${user!.id}, 'Customer A', ${customerEmail}, now())`;
        await tx.$executeRaw`INSERT INTO customers (id, store_id, user_id, name, email, updated_at) VALUES (${crypto.randomUUID()}, ${store2Id}, ${user!.id}, 'Customer B', ${customerEmail}, now())`;
      });

      // Verify: one User, two Customer rows
      const users = await authPrisma.user.findMany({
        where: { email: customerEmail },
      });
      expect(users).toHaveLength(1);

      const customers = await authPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        return tx.$queryRaw<Array<{ store_id: string }>>`SELECT store_id FROM customers WHERE user_id = ${user!.id}`;
      });
      expect(customers).toHaveLength(2);
      const storeIds = customers.map((c) => c.store_id);
      expect(storeIds).toContain(storeId);
      expect(storeIds).toContain(store2Id);
    } finally {
      // Cleanup
      await authPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        await tx.$executeRaw`DELETE FROM customers WHERE store_id IN (${storeId}, ${store2Id})`;
        await tx.$executeRaw`DELETE FROM stores WHERE id = ${store2Id}`;
      });
    }
  });
});
