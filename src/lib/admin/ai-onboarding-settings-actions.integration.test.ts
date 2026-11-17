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
  revalidatePath: () => {},
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

import AiOnboardingSettingsPage from "@/app/admin/(shell)/settings/ai-onboarding/page";
import { saveAiOnboardingSettingsAction } from "./ai-onboarding-settings-actions";
import { authPrisma, platformAdmin } from "../db";
import { lastAiOnboardingChange, readAiOnboardingSettings, type AiOnboardingSettings } from "./ai-onboarding-settings";
import { withAiOnboardingSettings } from "./platform-settings-test-lock";
import { authPost, testSignUp, collectCookies } from "../test-auth";

const suffix = `${Date.now()}-aio561`;
const password = "GuardPass-123!";
const emails = {
  admin: `aio561-admin-${suffix}@test.example`,
  member: `aio561-member-${suffix}@test.example`,
  customer: `aio561-customer-${suffix}@test.example`,
};
const storeId = crypto.randomUUID();
type Field = keyof AiOnboardingSettings;

async function signUpAndIn(email: string): Promise<{ userId: string; cookies: string }> {
  const signedUp = await testSignUp({ email, password, name: "Settings 561" });
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

function form(values: Partial<Record<Field, string>>, base: AiOnboardingSettings): FormData {
  const data = new FormData();
  for (const field of Object.keys(base) as Field[]) data.set(field, values[field] ?? String(base[field]));
  return data;
}

const auditRows = () => platformAdmin.auditLog.findMany({
  where: { action: "platform.ai_onboarding_settings_update", actorEmail: { in: Object.values(emails) } },
  orderBy: { createdAt: "asc" },
});

describe.skipIf(!process.env.DATABASE_URL)("AI and onboarding settings page (#561)", () => {
  const sessions: Record<keyof typeof emails, { userId: string; cookies: string }> = {} as never;

  beforeAll(async () => {
    for (const role of Object.keys(emails) as Array<keyof typeof emails>) sessions[role] = await signUpAndIn(emails[role]);
    await authPrisma.user.update({ where: { id: sessions.admin.userId }, data: { role: "platform_admin" } });
    sessions.admin.cookies = await withVerified2FA(sessions.admin.cookies);
    sessions.member.cookies = await withVerified2FA(sessions.member.cookies);
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, 'Settings 561', ${`aio561-${suffix}`}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${sessions.member.userId}, 'owner', now())`;
    });
  }, 60_000);

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

  it("AC2: a platform admin saves new values; the next read uses them, one audit row holds before and after, and the last change names them", async () => {
    headerState.set("cookie", sessions.admin.cookies);
    await withAiOnboardingSettings({}, async () => {
      const original = await readAiOnboardingSettings();
      const floor = original.goLiveListingFloor === 25 ? 26 : 25;
      const before = (await auditRows()).length;
      const savedFrom = new Date(Date.now() - 1000);

      const result = await saveAiOnboardingSettingsAction({}, form({ goLiveListingFloor: String(floor), rejectedApplicationRetentionMonths: "18" }, original));

      expect(result).toMatchObject({ saved: true });
      const after = { ...original, goLiveListingFloor: floor, rejectedApplicationRetentionMonths: 18 };
      expect(await readAiOnboardingSettings()).toEqual(after);
      const rows = await auditRows();
      expect(rows).toHaveLength(before + 1);
      expect(rows.at(-1)).toMatchObject({ storeId: null, actorId: sessions.admin.userId, actorEmail: emails.admin, before: { ...original }, after });
      const last = await lastAiOnboardingChange();
      expect(last?.actorEmail).toBe(emails.admin);
      expect(last?.at.getTime()).toBeGreaterThanOrEqual(savedFrom.getTime());

      const unchanged = await saveAiOnboardingSettingsAction({}, form({ goLiveListingFloor: String(floor), rejectedApplicationRetentionMonths: "18" }, original));
      expect(unchanged).toMatchObject({ saved: true });
      expect(await auditRows()).toHaveLength(before + 1);
    });
  });

  it("AC2: a value out of range or malformed is refused, never clamped, and nothing is written", async () => {
    headerState.set("cookie", sessions.admin.cookies);
    await withAiOnboardingSettings({}, async () => {
      const original = await readAiOnboardingSettings();
      const before = (await auditRows()).length;
      const cases: Array<[Partial<Record<Field, string>>, Field]> = [
        [{ goLiveListingFloor: "0" }, "goLiveListingFloor"],
        [{ goLiveListingFloor: "201" }, "goLiveListingFloor"],
        [{ dailySamplePerStore: "-1" }, "dailySamplePerStore"],
        [{ dailySamplePerStore: "21" }, "dailySamplePerStore"],
        [{ turnCostFlagCents: "0" }, "turnCostFlagCents"],
        [{ turnCostFlagCents: "101" }, "turnCostFlagCents"],
        [{ turnCostFlagCents: "2.5" }, "turnCostFlagCents"],
        [{ rejectedApplicationRetentionMonths: "0" }, "rejectedApplicationRetentionMonths"],
        [{ rejectedApplicationRetentionMonths: "25" }, "rejectedApplicationRetentionMonths"],
        [{ rejectedApplicationRetentionMonths: "" }, "rejectedApplicationRetentionMonths"],
      ];
      for (const [values, field] of cases) {
        const result = await saveAiOnboardingSettingsAction({}, form(values, original));
        expect(result.saved, JSON.stringify(values)).toBeUndefined();
        expect(Object.keys(result.fieldErrors ?? {}), JSON.stringify(values)).toEqual([field]);
        expect(result.submitted?.[field], JSON.stringify(values)).toBe(values[field]);
      }
      // Zero random chats is allowed: the review list then shows only flagged chats.
      expect(await saveAiOnboardingSettingsAction({}, form({ dailySamplePerStore: "0" }, original))).toMatchObject({ saved: true });
      expect(await readAiOnboardingSettings()).toEqual({ ...original, dailySamplePerStore: 0 });
      expect(await auditRows()).toHaveLength(before + 1);
    });
  });

  it("AC2: a store member, a customer and a signed-out visitor are sent to sign-in by the page and the action, and nothing is written", async () => {
    await withAiOnboardingSettings({}, async () => {
      const original = await readAiOnboardingSettings();
      const before = (await auditRows()).length;
      for (const cookies of [sessions.member.cookies, sessions.customer.cookies, null]) {
        if (cookies) headerState.set("cookie", cookies);
        else headerState.delete("cookie");
        await expect(AiOnboardingSettingsPage()).rejects.toThrow("REDIRECT:/admin/sign-in");
        await expect(saveAiOnboardingSettingsAction({}, form({ goLiveListingFloor: "1" }, original))).rejects.toThrow("REDIRECT:/admin/sign-in");
      }
      expect(await readAiOnboardingSettings()).toEqual(original);
      expect(await auditRows()).toHaveLength(before);
    });
  });
});
