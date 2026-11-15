import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});
import { generateTOTP } from "../../e2e/totp";

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

vi.mock("server-only", () => ({}));

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
import { syncCustomerForRequest } from "./customer-sync";
import { createInvite, setInviteePassword } from "./invite/service";
import { sendSignInLinkAction } from "./customer-sign-in/actions";
import { verifyUrlFromEmail } from "./test-magic-link";
import { storeScoped } from "./db";

const BASE = "http://localhost:3000/api/auth";
const suffix = `${Date.now()}-c1`;
const password = "GuardPass-123!";

async function authPost(
  path: string,
  body: unknown,
  cookies?: string,
  extra?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extra };
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

function cookiePairs(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).map((line) => line.split(";")[0]).join("; ");
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

  it("trustDevice never skips the second step, and a backup code yields a verified session", async () => {
    const email = `c1-recover-${suffix}@test.example`;
    try {
      await signUp(email, "C1 Recover");
      const recoverId = (await authPrisma.user.findFirstOrThrow({ where: { email } })).id;
      await authPrisma.user.update({ where: { id: recoverId }, data: { role: "platform_admin" } });
      const first = collectCookies(await passwordSignIn(email));
      const enabled = await authPost("/two-factor/enable", { password }, first);
      const { totpURI, backupCodes } = (await enabled.json()) as { totpURI: string; backupCodes: string[] };
      expect(backupCodes.length).toBeGreaterThan(0);
      const secret = secretFromUri(totpURI);
      const enrolled = await verifyTotp(generateTOTP(secret), first);
      expect(enrolled.status, await enrolled.clone().text()).toBe(200);
      const challenged = await passwordSignIn(email);
      expect((await challenged.clone().json()).twoFactorRedirect).toBe(true);
      const trusted = await authPost(
        "/two-factor/verify-totp",
        { code: generateTOTP(secret), trustDevice: true },
        cookiePairs(challenged),
      );
      expect(trusted.status, await trusted.clone().text()).toBe(200);
      const trustCookie = cookiePairs(trusted);
      const next = await authPost("/sign-in/email", { email, password }, trustCookie);
      const nextBody = await next.json();
      expect(nextBody.twoFactorRedirect).toBe(true);

      const recovered = await authPost(
        "/two-factor/verify-backup-code",
        { code: backupCodes[0] },
        cookiePairs(next),
      );
      expect(recovered.status, await recovered.clone().text()).toBe(200);
      headerState.set("cookie", collectCookies(recovered));
      const session = await requirePlatformAdmin();
      expect(session.user.id).toBe(recoverId);
      expect(session.session.twoFactorVerified).toBe(true);

      const reused = await authPost(
        "/two-factor/verify-backup-code",
        { code: backupCodes[0] },
        cookiePairs(await passwordSignIn(email)),
      );
      expect(reused.status).not.toBe(200);
    } finally {
      await removeAuthFixtures([email], []);
    }
  });

  it("the no-JS sign-in form sends a store-host link through the auth handler, and refuses off a store host", async () => {
    const email = `c1-form-${suffix}@test.example`;
    const host = `${storeSlug}.localhost:3000`;
    const form = new FormData();
    form.set("email", ` ${email.toUpperCase()} `);
    try {
      clearTestSentEmails();
      for (const key of [...headerState.keys()]) headerState.delete(key);
      headerState.set("host", host);
      headerState.set("x-forwarded-for", "10.181.0.9");
      const offStore = await sendSignInLinkAction({ status: "idle", email: "" }, form);
      expect(offStore.status).toBe("error");
      expect(getTestSentEmails()).toHaveLength(0);

      headerState.set("x-store-slug", storeSlug);
      expect(await sendSignInLinkAction({ status: "idle", email: "" }, form)).toEqual({ status: "sent", email });
      const mail = getTestSentEmails().at(-1);
      expect(mail?.to).toBe(email);
      expect(new URL(verifyUrlFromEmail(mail!.html)!).host).toBe(host);

      clearTestSentEmails();
      form.set("email", ownerEmail);
      expect((await sendSignInLinkAction({ status: "idle", email: "" }, form)).status).toBe("sent");
      expect(getTestSentEmails()).toHaveLength(0);
    } finally {
      for (const key of [...headerState.keys()]) headerState.delete(key);
      await removeAuthFixtures([email], []);
    }
  });

  it("a forgotten password resets by email, ends old sessions, and still needs the second step", async () => {
    const email = `c1-reset-${suffix}@test.example`;
    try {
      await signUp(email, "C1 Reset");
      const userId = (await authPrisma.user.findFirstOrThrow({ where: { email } })).id;
      await authPrisma.user.update({ where: { id: userId }, data: { role: "platform_admin" } });
      const first = collectCookies(await passwordSignIn(email));
      await enableTotp(first);
      await authPrisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
      const before = await authPrisma.session.count({ where: { userId } });
      expect(before).toBeGreaterThan(0);

      clearTestSentEmails();
      const requested = await authPost("/request-password-reset", { email, redirectTo: "/admin/reset-password" });
      expect(requested.status, await requested.clone().text()).toBe(200);
      const mail = getTestSentEmails().at(-1);
      expect(mail?.to).toBe(email);
      const link = mail!.html.match(/href="([^"]+)"/)![1].replace(/&amp;/g, "&");
      const landed = await authGet(link);
      const location = new URL(landed.headers.get("location")!, BASE);
      expect(location.pathname).toBe("/admin/reset-password");
      const token = location.searchParams.get("token")!;

      const reset = await authPost("/reset-password", { token, newPassword: "Reset-Pass-789!" });
      expect(reset.status, await reset.clone().text()).toBe(200);
      expect(await authPrisma.session.count({ where: { userId } })).toBe(0);
      expect((await passwordSignIn(email)).status).not.toBe(200);
      const fresh = await authPost("/sign-in/email", { email, password: "Reset-Pass-789!" });
      expect((await fresh.json()).twoFactorRedirect).toBe(true);
      expect((await authPost("/reset-password", { token, newPassword: "Again-Pass-000!" })).status).not.toBe(200);
    } finally {
      await removeAuthFixtures([email], []);
    }
  });

  it("a shopper who only ever used a magic link can set a password from a staff invite, once", async () => {
    const email = `c1-shopper-invitee-${suffix}@test.example`;
    try {
      await customerMagicSession(email, storeSlug);
      clearTestSentEmails();
      await createInvite({
        storeId,
        email,
        role: "staff",
        invitedById: ownerId,
        actorEmail: ownerEmail,
        baseUrl: "http://localhost:3000",
        storeSlug,
        storeName: "C1 Store",
      });
      const token = getTestSentEmails().at(-1)!.html.match(/\/invite\/([^?"]+)/)![1];
      expect((await passwordSignIn(email)).status).not.toBe(200);

      expect(await setInviteePassword(token, password)).toEqual({ ok: true });
      const signedIn = await passwordSignIn(email);
      expect(signedIn.status, await signedIn.clone().text()).toBe(200);

      // An account that has a password keeps it: the invite link cannot replace it.
      expect(await setInviteePassword(token, "Other-Pass-456!")).toEqual({ ok: true });
      expect((await authPost("/sign-in/email", { email, password: "Other-Pass-456!" })).status).not.toBe(200);
      expect(await setInviteePassword("not-a-token", password)).toEqual({ ok: false, error: "Invalid invitation link" });
    } finally {
      await authPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        await tx.$executeRaw`DELETE FROM store_invites WHERE email = ${email}`;
        await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id = ${storeId}`;
        await tx.$executeRaw`DELETE FROM customers WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
      });
      await removeAuthFixtures([email], []);
    }
  });

  it("a staff member opening the storefront account page is not synced into its customers", async () => {
    const email = `c1-staff-shopper-${suffix}@test.example`;
    try {
      const res = await authPost("/sign-up/email", { email, password, name: "C1 Staff Shopper" });
      expect(res.status).toBe(200);
      const userId = (await authPrisma.user.findFirstOrThrow({ where: { email } })).id;
      await insertOwnerMembership(storeId, userId);
      asStore(cookiePairs(res));
      expect(await syncCustomerForRequest()).toBeNull();
      expect(await storeScoped(storeId).customer.count({ where: { userId } })).toBe(0);
    } finally {
      await authPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        await tx.$executeRaw`DELETE FROM store_memberships WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM customers WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
      });
      await removeAuthFixtures([email], []);
    }
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
    const href = (verifyUrlFromEmail(html) ?? undefined);
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

type LiveSession = { id: string; userId: string; twoFactorVerified: boolean };

async function readSession(cookies: string): Promise<LiveSession | null> {
  const res = await authGet(`${BASE}/get-session`, cookies);
  const body = (await res.json()) as {
    session: { id: string; twoFactorVerified: boolean } | null;
    user: { id: string };
  } | null;
  if (!body?.session) return null;
  return {
    id: body.session.id,
    userId: body.user.id,
    twoFactorVerified: body.session.twoFactorVerified,
  };
}

async function waitForNextTotpWindow(): Promise<void> {
  const periodMs = 30_000;
  const waitMs = periodMs - (Date.now() % periodMs) + 400;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function insertStore(slug: string): Promise<string> {
  const id = crypto.randomUUID();
  await authPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${id}, ${slug}, ${slug}, 'active', now())`;
  });
  return id;
}

async function insertOwnerMembership(storeId: string, userId: string): Promise<void> {
  await authPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${userId}, 'owner', now())`;
  });
}

async function removeAuthFixtures(emails: string[], storeIds: string[]): Promise<void> {
  await authPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    for (const storeId of storeIds) {
      await tx.$executeRaw`DELETE FROM store_memberships WHERE store_id = ${storeId}`;
      await tx.$executeRaw`DELETE FROM customers WHERE store_id = ${storeId}`;
    }
    for (const email of emails) {
      await tx.$executeRaw`DELETE FROM two_factors WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
      await tx.$executeRaw`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
      await tx.$executeRaw`DELETE FROM accounts WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
      await tx.$executeRaw`DELETE FROM verifications WHERE value LIKE ${"%" + email + "%"} OR value IN (SELECT id FROM users WHERE email = ${email})`;
      await tx.$executeRaw`DELETE FROM users WHERE email = ${email}`;
    }
    for (const storeId of storeIds) {
      await tx.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
    }
  });
}

async function customerMagicSession(email: string, slug: string): Promise<LiveSession & { cookies: string }> {
  clearTestSentEmails();
  const sent = await authPost(
    "/sign-in/magic-link",
    { email, callbackURL: "/account" },
    undefined,
    { "x-store-slug": slug, host: `${slug}.localhost:3000` },
  );
  expect(sent.status, await sent.clone().text()).toBe(200);
  const html = getTestSentEmails().at(-1)?.html ?? "";
  const href = (verifyUrlFromEmail(html) ?? undefined);
  expect(href).toBeTruthy();
  const verifyRes = await authGet(href!);
  const cookies = collectCookies(verifyRes);
  expect(cookies).toContain("session_token");
  const session = await readSession(cookies);
  expect(session).toMatchObject({ twoFactorVerified: false });
  return { cookies, ...session! };
}

async function unverifiedPasswordSession(email: string): Promise<LiveSession & { cookies: string }> {
  const signedIn = await passwordSignIn(email);
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  const cookies = collectCookies(signedIn);
  const session = await readSession(cookies);
  expect(session).toMatchObject({ twoFactorVerified: false });
  return { cookies, ...session! };
}

describe("session cleanup stays inside one account", () => {
  it(
    "a staff TOTP sign-in keeps a customer's session and ends only the staff account's own unverified sessions",
    async () => {
      const stamp = crypto.randomUUID().slice(0, 8);
      const ownerEmail = `ac7-owner-${stamp}@test.example`;
      const customerAEmail = `ac7-a-${stamp}@test.example`;
      const customerBEmail = `ac7-b-${stamp}@test.example`;
      const emails = [ownerEmail, customerAEmail, customerBEmail];
      const storeIds: string[] = [];
      try {
        await signUp(ownerEmail, "AC7 Owner");
        await signUp(customerAEmail, "AC7 Customer A");
        await signUp(customerBEmail, "AC7 Customer B");
        const storeA = await insertStore(`ac7-a-${stamp}`);
        const storeB = await insertStore(`ac7-b-${stamp}`);
        storeIds.push(storeA, storeB);

        const customerA = await customerMagicSession(customerAEmail, `ac7-a-${stamp}`);
        const customerB = await customerMagicSession(customerBEmail, `ac7-b-${stamp}`);
        expect(customerA.userId).not.toBe(customerB.userId);

        const oldDevice = await unverifiedPasswordSession(ownerEmail);
        const enrollment = await unverifiedPasswordSession(ownerEmail);
        expect(oldDevice.id).not.toBe(enrollment.id);
        expect(oldDevice.userId).toBe(enrollment.userId);
        expect(oldDevice.userId).not.toBe(customerA.userId);
        expect(await readSession(oldDevice.cookies)).toMatchObject({
          id: oldDevice.id,
          userId: oldDevice.userId,
          twoFactorVerified: false,
        });
        expect(await readSession(enrollment.cookies)).toMatchObject({
          id: enrollment.id,
          userId: enrollment.userId,
          twoFactorVerified: false,
        });

        await insertOwnerMembership(storeA, oldDevice.userId);
        const secret = await enableTotp(enrollment.cookies);
        expect(await readSession(oldDevice.cookies)).toMatchObject({
          id: oldDevice.id,
          twoFactorVerified: false,
        });
        expect(await readSession(enrollment.cookies)).toMatchObject({
          id: enrollment.id,
          twoFactorVerified: false,
        });

        const verified = await verifyTotp(generateTOTP(secret), enrollment.cookies);
        expect(verified.status, await verified.clone().text()).toBe(200);
        const verifiedCookies = collectCookies(verified);
        const verifiedSession = await readSession(verifiedCookies);
        expect(verifiedSession).toMatchObject({
          userId: oldDevice.userId,
          twoFactorVerified: true,
        });
        expect(verifiedSession!.id).not.toBe(oldDevice.id);
        expect(verifiedSession!.id).not.toBe(enrollment.id);
        expect(await readSession(oldDevice.cookies)).toBeNull();
        expect(await readSession(customerA.cookies)).toMatchObject({
          id: customerA.id,
          userId: customerA.userId,
        });
        expect(await readSession(customerB.cookies)).toMatchObject({
          id: customerB.id,
          userId: customerB.userId,
        });

        await waitForNextTotpWindow();
        const challenge = await passwordSignIn(ownerEmail);
        expect(challenge.status, await challenge.clone().text()).toBe(200);
        expect((await challenge.json()).twoFactorRedirect).toBe(true);
        const signedInAgain = await verifyTotp(generateTOTP(secret), collectCookies(challenge));
        expect(signedInAgain.status, await signedInAgain.clone().text()).toBe(200);
        const newestCookies = collectCookies(signedInAgain);
        const newest = await readSession(newestCookies);
        expect(newest).toMatchObject({
          userId: oldDevice.userId,
          twoFactorVerified: true,
        });
        expect(newest!.id).not.toBe(verifiedSession!.id);
        expect(await readSession(verifiedCookies)).toMatchObject({
          id: verifiedSession!.id,
          userId: oldDevice.userId,
          twoFactorVerified: true,
        });
        expect(await readSession(newestCookies)).toMatchObject({
          id: newest!.id,
          twoFactorVerified: true,
        });
        expect(await readSession(customerA.cookies)).toMatchObject({ id: customerA.id });
        expect(await readSession(customerB.cookies)).toMatchObject({ id: customerB.id });
      } finally {
        await removeAuthFixtures(emails, storeIds);
      }
    },
    90_000,
  );

  it(
    "parallel TOTP sign-ins keep both verified sessions and unrelated customer sessions",
    async () => {
      const stamp = crypto.randomUUID().slice(0, 8);
      const ownerEmail = `ac7-parallel-${stamp}@test.example`;
      const customerAEmail = `ac7-parallel-a-${stamp}@test.example`;
      const customerBEmail = `ac7-parallel-b-${stamp}@test.example`;
      const emails = [ownerEmail, customerAEmail, customerBEmail];
      const storeIds: string[] = [];
      try {
        await signUp(ownerEmail, "AC7 Parallel Owner");
        await signUp(customerAEmail, "AC7 Parallel Customer A");
        await signUp(customerBEmail, "AC7 Parallel Customer B");
        const storeA = await insertStore(`ac7-pa-${stamp}`);
        const storeB = await insertStore(`ac7-pb-${stamp}`);
        storeIds.push(storeA, storeB);
        const enrollment = await unverifiedPasswordSession(ownerEmail);
        await insertOwnerMembership(storeA, enrollment.userId);
        const secret = await enableTotp(enrollment.cookies);
        const enrolled = await verifyTotp(generateTOTP(secret), enrollment.cookies);
        expect(enrolled.status, await enrolled.clone().text()).toBe(200);
        const existingCookies = collectCookies(enrolled);
        const existing = await readSession(existingCookies);
        expect(existing).toMatchObject({
          userId: enrollment.userId,
          twoFactorVerified: true,
        });

        const customerA = await customerMagicSession(customerAEmail, `ac7-pa-${stamp}`);
        const customerB = await customerMagicSession(customerBEmail, `ac7-pb-${stamp}`);
        expect(customerA.userId).not.toBe(customerB.userId);
        expect(customerA.userId).not.toBe(enrollment.userId);

        await waitForNextTotpWindow();
        const [firstChallenge, secondChallenge] = await Promise.all([
          passwordSignIn(ownerEmail),
          passwordSignIn(ownerEmail),
        ]);
        expect(firstChallenge.status, await firstChallenge.clone().text()).toBe(200);
        expect(secondChallenge.status, await secondChallenge.clone().text()).toBe(200);
        expect((await firstChallenge.json()).twoFactorRedirect).toBe(true);
        expect((await secondChallenge.json()).twoFactorRedirect).toBe(true);
        const firstCookies = collectCookies(firstChallenge);
        const secondCookies = collectCookies(secondChallenge);
        const code = generateTOTP(secret);
        const [firstVerified, secondVerified] = await Promise.all([
          verifyTotp(code, firstCookies),
          verifyTotp(code, secondCookies),
        ]);
        expect(firstVerified.status, await firstVerified.clone().text()).toBe(200);
        expect(secondVerified.status, await secondVerified.clone().text()).toBe(200);
        const firstSession = await readSession(collectCookies(firstVerified));
        const secondSession = await readSession(collectCookies(secondVerified));
        expect(firstSession).toMatchObject({
          userId: enrollment.userId,
          twoFactorVerified: true,
        });
        expect(secondSession).toMatchObject({
          userId: enrollment.userId,
          twoFactorVerified: true,
        });
        expect(firstSession!.id).not.toBe(secondSession!.id);
        expect(firstSession!.id).not.toBe(existing!.id);
        expect(secondSession!.id).not.toBe(existing!.id);
        expect(await readSession(existingCookies)).toMatchObject({
          id: existing!.id,
          twoFactorVerified: true,
        });
        expect(await readSession(customerA.cookies)).toMatchObject({ id: customerA.id });
        expect(await readSession(customerB.cookies)).toMatchObject({ id: customerB.id });
      } finally {
        await removeAuthFixtures(emails, storeIds);
      }
    },
    90_000,
  );
});
