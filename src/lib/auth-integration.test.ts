import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { auth } from "./auth";
import { authPrisma, platformAdmin } from "./db";
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
      await tx.$executeRawUnsafe(
        `INSERT INTO stores (id, name, slug, status, updated_at) VALUES ($1, 'Integ Test Store', $2, 'active', now())`,
        storeId,
        storeSlug,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES ($1, $2, $3, 'staff', now())`,
        crypto.randomUUID(),
        storeId,
        staffUserId,
      );
    });
  });

  afterAll(async () => {
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRawUnsafe(
        `DELETE FROM store_memberships WHERE store_id = $1`,
        storeId,
      );
      const emails = [customerEmail, staffEmail, adminEmail];
      for (const email of emails) {
        await tx.$executeRawUnsafe(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)`, email);
        await tx.$executeRawUnsafe(`DELETE FROM accounts WHERE user_id IN (SELECT id FROM users WHERE email = $1)`, email);
        await tx.$executeRawUnsafe(`DELETE FROM verifications WHERE identifier = $1`, email);
        await tx.$executeRawUnsafe(`DELETE FROM users WHERE email = $1`, email);
      }
      await tx.$executeRawUnsafe(`DELETE FROM stores WHERE id = $1`, storeId);
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
      await tx.$executeRawUnsafe(
        `DELETE FROM store_memberships WHERE store_id = $1 AND user_id = $2`,
        storeId,
        staffUserId,
      );
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
      await tx.$executeRawUnsafe(
        `INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES ($1, $2, $3, 'staff', now())`,
        crypto.randomUUID(),
        storeId,
        staffUserId,
      );
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
});
