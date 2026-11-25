import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateTOTP } from "../../../e2e/totp";

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

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { authPrisma, storeScoped } from "../db";
import { requirePlatformAdmin } from "../admin/session";
import { requireStoreMember } from "./session";
import { inviteMemberAction, removeMemberAction } from "./actions";
import { approveIssueAction, cancelShipmentAction, markNoShowAction, storeRefundAction, storeRefundPreviewAction } from "../order/actions";
import { authPost, collectCookies, testSignUp } from "../test-auth";

const suffix = `${Date.now()}-2fa840`;
const password = "StepUpPass-123!";
const ownerEmail = `su-owner-${suffix}@test.example`;
const staffEmail = `su-staff-${suffix}@test.example`;
const adminEmail = `su-admin-${suffix}@test.example`;
const slug = `su-${suffix}`;
const ORDER_ID = crypto.randomUUID();

async function signUp(email: string, name: string): Promise<string> {
  const res = await testSignUp({ email, password, name });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await authPrisma.user.findFirstOrThrow({ where: { email } })).id;
}

async function passwordSignIn(email: string): Promise<Response> {
  return authPost("/sign-in/email", { email, password });
}

/** Turns 2FA on from a password session and returns the verified session's cookies. */
async function enrollTotp(cookies: string): Promise<{ cookies: string; secret: string }> {
  const enabled = await authPost("/two-factor/enable", { password }, cookies);
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret");
  if (!secret) throw new Error("TOTP URI has no secret");
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
  expect(verified.status, await verified.clone().text()).toBe(200);
  return { cookies: collectCookies(verified) || cookies, secret };
}

function asMember(cookies: string, page = `/store-admin/team?store=${slug}`) {
  headerState.set("cookie", cookies);
  headerState.set("x-store-slug", slug);
  headerState.set("x-request-path", page);
}

function inviteForm(email: string): FormData {
  const form = new FormData();
  form.set("email", email);
  return form;
}

const STEP_UP = {
  error: expect.stringMatching(/two-factor/i),
  setupHref: expect.stringContaining("/store-admin/two-factor?"),
};

describe("store 2FA is optional, and required before money and team actions (#840)", () => {
  let storeId = "";
  let ownerId = "";
  let staffId = "";
  let ownerCookies = "";

  beforeAll(async () => {
    ownerId = await signUp(ownerEmail, "Step-up Owner");
    staffId = await signUp(staffEmail, "Step-up Staff");
    const adminId = await signUp(adminEmail, "Step-up Admin");
    await authPrisma.user.update({ where: { id: adminId }, data: { role: "platform_admin" } });
    storeId = crypto.randomUUID();
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, 'Step-up Store', ${slug}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${ownerId}, 'owner', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${staffId}, 'staff', now())`;
    });
    const signedIn = await passwordSignIn(ownerEmail);
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    ownerCookies = collectCookies(signedIn);
  });

  afterAll(async () => {
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id = ${storeId}`;
      await tx.$executeRaw`DELETE FROM store_invites WHERE store_id = ${storeId}`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE store_id = ${storeId}`;
      for (const email of [ownerEmail, staffEmail, adminEmail]) {
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM users WHERE email = ${email}`;
      }
      await tx.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
    });
  });

  it("an owner without 2FA signs in with a password and reaches store admin", async () => {
    asMember(ownerCookies, `/store-admin?store=${slug}`);
    const member = await requireStoreMember();
    expect(member.user.id).toBe(ownerId);
    expect(member.user.twoFactorEnabled).toBe(false);
  });

  it("without 2FA, refunds and team changes are refused in the action, with a link back to the same page, and nothing is written", async () => {
    asMember(ownerCookies, `/store-admin/team?store=${slug}`);
    const invited = await inviteMemberAction(inviteForm(`blocked-${suffix}@test.example`));
    expect(invited).toEqual(STEP_UP);
    const href = new URL((invited as { setupHref: string }).setupHref, "http://x.invalid");
    expect(href.searchParams.get("next")).toBe(`/store-admin/team?store=${slug}`);
    expect(await removeMemberAction(staffId)).toEqual(STEP_UP);
    expect(await storeScoped(storeId).storeInvite.count()).toBe(0);
    expect(await storeScoped(storeId).storeMembership.count()).toBe(2);

    asMember(ownerCookies, `/store-admin/orders?store=${slug}`);
    const submissionId = crypto.randomUUID();
    expect(await storeRefundAction(ORDER_ID, { picks: "whole_order", reason: "Bruised", submissionId })).toEqual({ ok: false, ...STEP_UP });
    expect(await storeRefundPreviewAction(ORDER_ID, "whole_order")).toEqual({ ok: false, ...STEP_UP });
    expect(await markNoShowAction(ORDER_ID)).toEqual({ ok: false, ...STEP_UP });
    expect(await approveIssueAction(crypto.randomUUID())).toEqual({ ok: false, ...STEP_UP });
    // Cancelling a ready ship order refunds the whole capture.
    expect(await cancelShipmentAction(ORDER_ID)).toEqual({ ok: false, ...STEP_UP });
  });

  it("a link back is never to another site", async () => {
    asMember(ownerCookies, "//evil.example/store-admin");
    const invited = (await inviteMemberAction(inviteForm(`evil-${suffix}@test.example`))) as { setupHref: string };
    const next = new URL(invited.setupHref, "http://x.invalid").searchParams.get("next");
    expect(next).toBe(`/store-admin?store=${slug}`);
  });

  it("with 2FA on and verified this session, the same invite and refund pass the gate", async () => {
    const enrolled = await enrollTotp(ownerCookies);
    ownerCookies = enrolled.cookies;
    asMember(ownerCookies);
    const invited = await inviteMemberAction(inviteForm(`allowed-${suffix}@test.example`));
    expect(invited).toMatchObject({ success: true });
    expect(await storeScoped(storeId).storeInvite.count()).toBe(1);

    asMember(ownerCookies, `/store-admin/orders?store=${slug}`);
    const refunded = await storeRefundAction(ORDER_ID, { picks: "whole_order", reason: "Bruised", submissionId: crypto.randomUUID() });
    // Past the gate: the made-up order is simply not found.
    expect(refunded).toMatchObject({ ok: false });
    expect(refunded).not.toHaveProperty("setupHref");
  });

  it("a member who has 2FA on still has to enter the code: the password alone gives no session", async () => {
    const signedIn = await passwordSignIn(ownerEmail);
    expect(signedIn.status).toBe(200);
    expect(((await signedIn.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    asMember(collectCookies(signedIn), `/store-admin?store=${slug}`);
    await expect(requireStoreMember()).rejects.toThrow(/REDIRECT:\/store-admin\/sign-in/);
  });

  it("a session that has not passed the second step is refused once the account has 2FA", async () => {
    const signedIn = await passwordSignIn(staffEmail);
    const staffCookies = collectCookies(signedIn);
    await authPrisma.user.update({ where: { id: staffId }, data: { twoFactorEnabled: true } });
    try {
      asMember(staffCookies, `/store-admin?store=${slug}`);
      await expect(requireStoreMember()).rejects.toThrow(/REDIRECT:\/store-admin\/sign-in/);
    } finally {
      await authPrisma.user.update({ where: { id: staffId }, data: { twoFactorEnabled: false } });
    }
  });

  it("a platform admin without 2FA is still refused", async () => {
    const signedIn = await passwordSignIn(adminEmail);
    headerState.set("cookie", collectCookies(signedIn));
    await expect(requirePlatformAdmin()).rejects.toThrow("REDIRECT:/admin/enroll-2fa");
  });
});
