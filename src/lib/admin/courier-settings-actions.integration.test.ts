import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateTOTP } from "../../../e2e/totp";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

vi.mock("next/headers", () => ({
  headers: async () => headerState,
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

import CourierSettingsPage from "@/app/admin/(shell)/settings/couriers/page";
import { saveCourierSettingsAction } from "./courier-settings-actions";
import { authPrisma, platformAdmin } from "../db";
import { readCourierSettings, type CourierSettings } from "../delivery/courier-settings";
import { authPost, testSignUp, collectCookies } from "../test-auth";

const suffix = `${Date.now()}-cs535`;
const password = "GuardPass-123!";
const emails = {
  admin: `cs535-admin-${suffix}@test.example`,
  member: `cs535-member-${suffix}@test.example`,
  customer: `cs535-customer-${suffix}@test.example`,
};
const storeId = crypto.randomUUID();

async function signUpAndIn(email: string): Promise<{ userId: string; cookies: string }> {
  const signedUp = await testSignUp({ email, password, name: "Courier 535" });
  expect(signedUp.status, await signedUp.clone().text()).toBe(200);
  const user = await authPrisma.user.findFirstOrThrow({ where: { email } });
  const signedIn = await authPost("/sign-in/email", { email, password });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  return { userId: user.id, cookies: collectCookies(signedIn) };
}

/** A session with 2FA enrolled and verified, as the admin guard asks of a platform admin. */
async function withVerified2FA(cookies: string): Promise<string> {
  const enabled = await authPost("/two-factor/enable", { password }, cookies);
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret");
  if (!secret) throw new Error("TOTP URI has no secret");
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
  expect(verified.status, await verified.clone().text()).toBe(200);
  return collectCookies(verified) || cookies;
}

function form(values: Partial<Record<"selectionMode" | "assignmentTimeoutSeconds" | "weightLimitLb", string>> & { doordash?: boolean; uber?: boolean }, base: CourierSettings): FormData {
  const data = new FormData();
  data.set("selectionMode", values.selectionMode ?? base.selectionMode);
  data.set("assignmentTimeoutSeconds", values.assignmentTimeoutSeconds ?? String(base.assignmentTimeoutSeconds));
  data.set("weightLimitLb", values.weightLimitLb ?? String(base.weightLimitLb));
  if (values.doordash ?? base.doordashEnabled) data.set("doordashEnabled", "on");
  if (values.uber ?? base.uberEnabled) data.set("uberEnabled", "on");
  return data;
}

// Scoped to the courier action: other files write platform_settings audit rows in parallel (#767).
const auditRows = () =>
  platformAdmin.auditLog.findMany({
    where: { entityType: "platform_settings", entityId: "platform", action: "platform.courier_settings_update" },
    orderBy: { createdAt: "asc" },
  });

/** Only the timeout is ever changed here, so other test files reading the shared row see no difference. */
async function restoreTimeout(seconds: number) {
  await authPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    await tx.$executeRaw`UPDATE platform_settings SET courier_assignment_timeout_s = ${seconds} WHERE id = 'platform'`;
  });
}

describe.skipIf(!process.env.DATABASE_URL)("courier settings page (#535)", () => {
  const sessions: Record<keyof typeof emails, { userId: string; cookies: string }> = {} as never;
  let original: CourierSettings;

  beforeAll(async () => {
    for (const role of Object.keys(emails) as Array<keyof typeof emails>) sessions[role] = await signUpAndIn(emails[role]);
    await authPrisma.user.update({ where: { id: sessions.admin.userId }, data: { role: "platform_admin" } });
    sessions.admin.cookies = await withVerified2FA(sessions.admin.cookies);
    sessions.member.cookies = await withVerified2FA(sessions.member.cookies);
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, 'Courier 535', ${`cs535-${suffix}`}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${sessions.member.userId}, 'owner', now())`;
    });
    original = await readCourierSettings();
  }, 60_000);

  // A failed attempt must not leave its timeout behind for the retry or the next test (#767).
  afterEach(async () => {
    if (original) await restoreTimeout(original.assignmentTimeoutSeconds);
  });

  afterAll(async () => {
    const userIds = Object.values(sessions).map((s) => s.userId);
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      for (const id of userIds) {
        await tx.$executeRaw`DELETE FROM audit_logs WHERE actor_id = ${id}`;
        await tx.$executeRaw`DELETE FROM store_memberships WHERE user_id = ${id}`;
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id = ${id}`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${id}`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id = ${id}`;
        await tx.$executeRaw`DELETE FROM users WHERE id = ${id}`;
      }
      await tx.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
    });
  }, 30_000);

  it("AC1/AC4: a platform admin saves a new timeout; the next read uses it and one audit row holds before and after", async () => {
    headerState.set("cookie", sessions.admin.cookies);
    const timeout = original.assignmentTimeoutSeconds === 900 ? 899 : 900;
    const before = (await auditRows()).length;

    const result = await saveCourierSettingsAction({}, form({ assignmentTimeoutSeconds: String(timeout) }, original));

    expect(result).toMatchObject({ saved: true });
    expect(await readCourierSettings()).toEqual({ ...original, assignmentTimeoutSeconds: timeout });
    const rows = await auditRows();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      storeId: null,
      actorId: sessions.admin.userId,
      actorEmail: emails.admin,
      action: "platform.courier_settings_update",
      before: { ...original },
      after: { ...original, assignmentTimeoutSeconds: timeout },
    });

    const unchanged = await saveCourierSettingsAction({}, form({ assignmentTimeoutSeconds: String(timeout) }, original));
    expect(unchanged).toMatchObject({ saved: true });
    expect(await auditRows()).toHaveLength(before + 1);

    expect(await saveCourierSettingsAction({}, form({}, original))).toMatchObject({ saved: true });
    expect(await readCourierSettings()).toEqual(original);
  });

  it("AC4: a value out of range or malformed is refused, never clamped, and nothing is written", async () => {
    headerState.set("cookie", sessions.admin.cookies);
    const before = (await auditRows()).length;
    const cases: Array<[Parameters<typeof form>[0], string]> = [
      [{ assignmentTimeoutSeconds: "299" }, "assignmentTimeoutSeconds"],
      [{ assignmentTimeoutSeconds: "1201" }, "assignmentTimeoutSeconds"],
      [{ assignmentTimeoutSeconds: "600.5" }, "assignmentTimeoutSeconds"],
      [{ assignmentTimeoutSeconds: "" }, "assignmentTimeoutSeconds"],
      [{ weightLimitLb: "0" }, "weightLimitLb"],
      [{ weightLimitLb: "101" }, "weightLimitLb"],
      [{ selectionMode: "fastest" }, "selectionMode"],
    ];
    for (const [values, field] of cases) {
      const result = await saveCourierSettingsAction({}, form(values, original));
      expect(result.saved, JSON.stringify(values)).toBeUndefined();
      expect(Object.keys(result.fieldErrors ?? {})).toEqual([field]);
    }
    expect(await readCourierSettings()).toEqual(original);
    expect(await auditRows()).toHaveLength(before);
  });

  it("AC5: a store member, a customer and a signed-out visitor are sent to sign-in by the page and the action, and nothing is written", async () => {
    const before = (await auditRows()).length;
    for (const cookies of [sessions.member.cookies, sessions.customer.cookies, null]) {
      if (cookies) headerState.set("cookie", cookies);
      else headerState.delete("cookie");
      await expect(CourierSettingsPage()).rejects.toThrow("REDIRECT:/admin/sign-in");
      await expect(saveCourierSettingsAction({}, form({ uber: false, doordash: false }, original))).rejects.toThrow("REDIRECT:/admin/sign-in");
    }
    expect(await readCourierSettings()).toEqual(original);
    expect(await auditRows()).toHaveLength(before);
  });
});
