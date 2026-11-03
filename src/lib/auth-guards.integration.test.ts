import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});
import { generateTOTP } from "../../e2e/totp";

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

import { auth } from "./auth";
import { authPrisma } from "./db";
import { requirePlatformAdmin } from "./admin/session";
import { requireStoreMember, requireStoreOwner } from "./store-admin/session";
import { clearTestSentEmails, getTestSentEmails } from "./email/send";

const BASE = "http://localhost:3000/api/auth";
const suffix = `${Date.now()}-c1`;
const password = "GuardPass-123!";

async function authPost(path: string, body: unknown, cookies?: string): Promise<Response> {
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

async function signUp(email: string, name: string): Promise<void> {
  const res = await authPost("/sign-up/email", { email, password, name });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function passwordSignIn(email: string): Promise<Response> {
  return authPost("/sign-in/email", { email, password });
}

function secretFromUri(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("TOTP URI has no secret");
  return secret;
}

async function enableTotp(cookies: string): Promise<string> {
  const res = await authPost("/two-factor/enable", { password }, cookies);
  expect(res.status, await res.clone().text()).toBe(200);
  const body = await res.json();
  return secretFromUri(body.totpURI as string);
}

async function verifyTotp(code: string, cookies: string): Promise<Response> {
  return authPost("/two-factor/verify-totp", { code }, cookies);
}

async function latestToken(email: string): Promise<string> {
  const rows = await authPrisma.verification.findMany({
    where: { identifier: { startsWith: "magic-link:" } },
    orderBy: { createdAt: "desc" },
    take: 15,
  });
  const row = rows.find((item) => item.value.includes(email));
  if (!row) throw new Error(`no magic link for ${email}`);
  return row.identifier.replace(/^magic-link:/, "");
}

describe("C1 real guards (lane DB, app_runtime)", () => {
  const ownerEmail = `c1-owner-${suffix}@test.example`;
  const adminEmail = `c1-admin-${suffix}@test.example`;
  const plainEmail = `c1-plain-${suffix}@test.example`;
  const storeSlug = `c1-store-${suffix}`;
  let storeId = "";
  let ownerId = "";
  let adminId = "";
  let plainId = "";

  beforeAll(async () => {
    await signUp(ownerEmail, "C1 Owner");
    await signUp(adminEmail, "C1 Admin");
    await signUp(plainEmail, "C1 Plain");

    const owner = await authPrisma.user.findFirstOrThrow({ where: { email: ownerEmail } });
    const admin = await authPrisma.user.findFirstOrThrow({ where: { email: adminEmail } });
    const plain = await authPrisma.user.findFirstOrThrow({ where: { email: plainEmail } });
    ownerId = owner.id;
    adminId = admin.id;
    plainId = plain.id;

    await authPrisma.user.update({
      where: { id: adminId },
      data: { role: "platform_admin" },
    });

    storeId = crypto.randomUUID();
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, 'C1 Store', ${storeSlug}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${ownerId}, 'owner', now())`;
    });
  });

  afterAll(async () => {
    const emails = [ownerEmail, adminEmail, plainEmail];
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE store_id = ${storeId}`;
      for (const email of emails) {
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM verifications WHERE value LIKE ${"%" + email + "%"} OR value IN (${ownerId}, ${adminId}, ${plainId})`;
        await tx.$executeRaw`DELETE FROM users WHERE email = ${email}`;
      }
      await tx.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
    });
  });

  function asStore(cookies: string) {
    headerState.set("cookie", cookies);
    headerState.set("x-store-slug", storeSlug);
  }

  it("password plus TOTP yields a verified session the real store guards accept", async () => {
    const signedIn = await passwordSignIn(ownerEmail);
    expect(signedIn.status).toBe(200);
    const cookies = collectCookies(signedIn);
    const secret = await enableTotp(cookies);
    const verified = await verifyTotp(generateTOTP(secret), cookies);
    expect(verified.status, await verified.clone().text()).toBe(200);
    const sessionCookies = collectCookies(verified) || cookies;

    const sessionRes = await authGet(`${BASE}/get-session`, sessionCookies);
    const sessionBody = await sessionRes.json();
    expect(sessionBody.session.twoFactorVerified).toBe(true);
    expect(sessionBody.user.twoFactorEnabled).toBe(true);

    asStore(sessionCookies);
    const member = await requireStoreMember();
    expect(member.user.id).toBe(ownerId);
    expect(member.membership.role).toBe("owner");
    const owner = await requireStoreOwner();
    expect(owner.user.id).toBe(ownerId);
  });

  it("password plus TOTP yields a verified session the platform guard accepts", async () => {
    const signedIn = await passwordSignIn(adminEmail);
    const cookies = collectCookies(signedIn);
    const secret = await enableTotp(cookies);
    const verified = await verifyTotp(generateTOTP(secret), cookies);
    expect(verified.status, await verified.clone().text()).toBe(200);
    const sessionCookies = collectCookies(verified) || cookies;

    headerState.set("cookie", sessionCookies);
    const session = await requirePlatformAdmin();
    expect(session.user.id).toBe(adminId);
    expect(session.session.twoFactorVerified).toBe(true);
  });

  it("magic link does not admit a 2FA store owner or platform admin", async () => {
    for (const [email, userId, guard] of [
      [ownerEmail, ownerId, "store"],
      [adminEmail, adminId, "platform"],
    ] as const) {
      clearTestSentEmails();
      await authPrisma.session.deleteMany({ where: { userId } });
      const sent = await authPost("/sign-in/magic-link", {
        email,
        callbackURL: "/account",
      });
      expect(sent.status).toBe(200);
      expect(getTestSentEmails()).toHaveLength(0);
      const token = await latestToken(email);
      const verifyRes = await authGet(
        `${BASE}/magic-link/verify?token=${token}&callbackURL=/account`,
      );
      expect(verifyRes.status).toBe(403);
      expect(collectCookies(verifyRes)).not.toContain("session_token");
      expect(await authPrisma.session.count({ where: { userId } })).toBe(0);

      headerState.set("cookie", "");
      headerState.set("x-store-slug", storeSlug);
      if (guard === "store") {
        await expect(requireStoreMember()).rejects.toThrow(/REDIRECT:\/store-admin\/sign-in/);
      } else {
        await expect(requirePlatformAdmin()).rejects.toThrow("REDIRECT:/admin/sign-in");
      }
    }
  });

  it("an existing unverified session is not upgraded by magic link or a password challenge", async () => {
    clearTestSentEmails();
    await authPrisma.user.update({
      where: { id: plainId },
      data: { emailVerified: true },
    });
    await authPrisma.session.deleteMany({ where: { userId: plainId } });
    const sent = await authPost("/sign-in/magic-link", {
      email: plainEmail,
      callbackURL: "/account",
    });
    expect(sent.status).toBe(200);
    const html = getTestSentEmails().at(-1)?.html ?? "";
    const href = html.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
    expect(href).toBeTruthy();
    const verifyRes = await authGet(href!);
    const cookies = collectCookies(verifyRes);
    const sessionRes = await authGet(`${BASE}/get-session`, cookies);
    const original = await sessionRes.json();
    expect(original.session.twoFactorVerified).toBe(false);
    const originalId = original.session.id as string;

    await authPrisma.user.update({
      where: { id: plainId },
      data: { twoFactorEnabled: true },
    });
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${plainId}, 'owner', now())`;
    });

    asStore(cookies);
    await expect(requireStoreMember()).rejects.toThrow(/REDIRECT:\/store-admin\/sign-in/);

    clearTestSentEmails();
    const again = await authPost("/sign-in/magic-link", {
      email: plainEmail,
      callbackURL: "/account",
    });
    expect(again.status).toBe(200);
    expect(getTestSentEmails()).toHaveLength(0);
    const blocked = await authGet(
      `${BASE}/magic-link/verify?token=${await latestToken(plainEmail)}&callbackURL=/account`,
    );
    expect(blocked.status).toBe(403);

    const challenge = await passwordSignIn(plainEmail);
    expect(challenge.status).toBe(200);
    const challengeBody = await challenge.json();
    expect(challengeBody.twoFactorRedirect).toBe(true);

    const still = await authPrisma.session.findUnique({ where: { id: originalId } });
    expect(still).toBeTruthy();
    expect(still?.twoFactorVerified).toBe(false);

    asStore(cookies);
    await expect(requireStoreOwner()).rejects.toThrow(/REDIRECT:\/store-admin\/sign-in/);
  });
});
