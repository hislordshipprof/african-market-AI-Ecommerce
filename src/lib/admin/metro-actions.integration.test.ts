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
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import MetrosPage from "@/app/admin/(shell)/metros/page";
import MetroPage from "@/app/admin/(shell)/metros/[id]/page";
import { saveMetroAction, setStoreMetroAction } from "./metro-actions";
import { authPrisma, platformAdmin, platformAdminTransaction } from "../db";
import { readStoreCourierSettings } from "../delivery/courier-settings";
import { authPost, collectCookies } from "../test-auth";

const suffix = `${Date.now()}-m577`;
const password = "GuardPass-123!";
const emails = {
  admin: `m577-admin-${suffix}@test.example`,
  member: `m577-member-${suffix}@test.example`,
  customer: `m577-customer-${suffix}@test.example`,
};
const storeId = crypto.randomUUID();
const metroIds: string[] = [];

async function signUpAndIn(email: string): Promise<{ userId: string; cookies: string }> {
  const signedUp = await authPost("/sign-up/email", { email, password, name: "Metro 577" });
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

type Values = Partial<Record<"metroId" | "name" | "states" | "centerLat" | "centerLng" | "radiusMi" | "courierSelectionMode" | "courierAssignmentTimeoutS", string>> & {
  doordash?: boolean;
  uber?: boolean;
};
const VALID = { name: `DMV ${suffix}`, states: "md, DC va", centerLat: "38.9072", centerLng: "-77.0369", radiusMi: "40", courierSelectionMode: "", courierAssignmentTimeoutS: "" };

function form(values: Values): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({ ...VALID, ...values })) if (typeof value === "string") data.set(key, value);
  if (values.doordash ?? true) data.set("doordashEnabled", "on");
  if (values.uber ?? true) data.set("uberEnabled", "on");
  return data;
}

async function created(values: Values): Promise<string> {
  const redirect = await saveMetroAction({}, form(values)).then(
    () => null,
    (err: Error) => err.message,
  );
  const id = redirect?.match(/^REDIRECT:\/admin\/metros\/(.+)$/)?.[1];
  if (!id) throw new Error(`expected a redirect to the new metro, got ${redirect}`);
  metroIds.push(id);
  return id;
}

const metroAudit = () => platformAdmin.auditLog.findMany({ where: { entityType: "metro", entityId: { in: metroIds } }, orderBy: { createdAt: "asc" } });

describe.skipIf(!process.env.DATABASE_URL)("metros (#577)", () => {
  const sessions: Record<keyof typeof emails, { userId: string; cookies: string }> = {} as never;

  beforeAll(async () => {
    for (const role of Object.keys(emails) as Array<keyof typeof emails>) sessions[role] = await signUpAndIn(emails[role]);
    await authPrisma.user.update({ where: { id: sessions.admin.userId }, data: { role: "platform_admin" } });
    sessions.admin.cookies = await withVerified2FA(sessions.admin.cookies);
    sessions.member.cookies = await withVerified2FA(sessions.member.cookies);
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, 'Metro 577', ${`m577-${suffix}`}, 'active', now())`;
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
      await tx.$executeRaw`DELETE FROM metros WHERE id = ANY(${metroIds})`;
    });
  }, 30_000);

  it("AC1/AC2: a platform admin adds a metro, puts a store in it and sets overrides; the store's courier settings follow, each change audited", async () => {
    headerState.set("cookie", sessions.admin.cookies);
    const id = await created({});
    expect(await platformAdminTransaction((tx) => tx.metro.findUniqueOrThrow({ where: { id } }))).toMatchObject({
      name: VALID.name, states: ["MD", "DC", "VA"], centerLat: 38.9072, centerLng: -77.0369, radiusMi: 40, courierSelectionMode: null, courierAssignmentTimeoutS: null,
    });

    await expect(setStoreMetroAction(form({ metroId: id, ...{ storeId } } as Values))).rejects.toThrow(`REDIRECT:/admin/stores/${storeId}?metro=saved`);
    const storeAudit = await platformAdmin.auditLog.findMany({ where: { storeId, action: "store.metro_set" } });
    expect(storeAudit).toMatchObject([{ actorId: sessions.admin.userId, before: { metroId: null }, after: { metroId: id } }]);

    const platformWide = await readStoreCourierSettings(crypto.randomUUID());
    expect(await saveMetroAction({}, form({ metroId: id, courierSelectionMode: "uber_first", courierAssignmentTimeoutS: "900", doordash: false }))).toEqual({ saved: true });
    expect(await readStoreCourierSettings(storeId)).toEqual({ ...platformWide, selectionMode: "uber_first", assignmentTimeoutSeconds: 900, doordashEnabled: false });

    const rows = await metroAudit();
    expect(rows.map((r) => r.action)).toEqual(["platform.metro_create", "platform.metro_update"]);
    expect(rows[1]).toMatchObject({
      actorId: sessions.admin.userId,
      before: { courierSelectionMode: null, courierAssignmentTimeoutS: null, doordashEnabled: true },
      after: { courierSelectionMode: "uber_first", courierAssignmentTimeoutS: 900, doordashEnabled: false },
    });

    // An unchanged save writes no audit row; taking the store out of the metro returns it to the platform settings.
    await saveMetroAction({}, form({ metroId: id, courierSelectionMode: "uber_first", courierAssignmentTimeoutS: "900", doordash: false }));
    expect(await metroAudit()).toHaveLength(2);
    await expect(setStoreMetroAction(form({ metroId: "", storeId } as Values))).rejects.toThrow("metro=saved");
    expect(await readStoreCourierSettings(storeId)).toEqual(platformWide);
  });

  it("AC2: a value out of range or malformed is refused, never clamped, and nothing is written", async () => {
    headerState.set("cookie", sessions.admin.cookies);
    const id = await created({ name: `Refusals ${suffix}` });
    const before = await platformAdminTransaction((tx) => tx.metro.findUniqueOrThrow({ where: { id } }));
    const audits = (await metroAudit()).length;
    const cases: Array<[Values, string]> = [
      [{ courierAssignmentTimeoutS: "299" }, "courierAssignmentTimeoutS"],
      [{ courierAssignmentTimeoutS: "1201" }, "courierAssignmentTimeoutS"],
      [{ courierAssignmentTimeoutS: "600.5" }, "courierAssignmentTimeoutS"],
      [{ courierSelectionMode: "fastest" }, "courierSelectionMode"],
      [{ radiusMi: "0" }, "radiusMi"],
      [{ radiusMi: "251" }, "radiusMi"],
      [{ states: "MD, ZZ" }, "states"],
      [{ states: " " }, "states"],
      [{ states: "AL AK AZ AR CA CO CT DE DC FL GA" }, "states"],
      [{ centerLat: "91" }, "centerLat"],
      [{ name: "" }, "name"],
    ];
    for (const [values, field] of cases) {
      const result = await saveMetroAction({}, form({ metroId: id, ...values }));
      expect(result.saved, JSON.stringify(values)).toBeUndefined();
      expect(Object.keys(result.fieldErrors ?? {}), JSON.stringify(values)).toEqual([field]);
    }
    expect(await saveMetroAction({}, form({ metroId: id, name: VALID.name }))).toMatchObject({ fieldErrors: { name: "Another metro has this name." } });
    expect(await platformAdminTransaction((tx) => tx.metro.findUniqueOrThrow({ where: { id } }))).toEqual(before);
    expect(await metroAudit()).toHaveLength(audits);
  });

  it("AC4: a store member, a customer and a signed-out visitor are sent to sign-in by the pages and the actions, and nothing is written", async () => {
    headerState.set("cookie", sessions.admin.cookies);
    const id = await created({ name: `Guarded ${suffix}` });
    const before = await platformAdminTransaction((tx) => tx.metro.findUniqueOrThrow({ where: { id } }));
    const audits = (await metroAudit()).length;
    for (const cookies of [sessions.member.cookies, sessions.customer.cookies, null]) {
      if (cookies) headerState.set("cookie", cookies);
      else headerState.delete("cookie");
      await expect(MetrosPage()).rejects.toThrow("REDIRECT:/admin/sign-in");
      await expect(MetroPage({ params: Promise.resolve({ id }) })).rejects.toThrow("REDIRECT:/admin/sign-in");
      await expect(saveMetroAction({}, form({ metroId: id, courierSelectionMode: "doordash_first" }))).rejects.toThrow("REDIRECT:/admin/sign-in");
      await expect(saveMetroAction({}, form({ name: `Intruder ${suffix}` }))).rejects.toThrow("REDIRECT:/admin/sign-in");
      await expect(setStoreMetroAction(form({ metroId: id, storeId } as Values))).rejects.toThrow("REDIRECT:/admin/sign-in");
    }
    expect(await platformAdminTransaction((tx) => tx.metro.findUniqueOrThrow({ where: { id } }))).toEqual(before);
    expect(await platformAdminTransaction((tx) => tx.metro.count({ where: { name: `Intruder ${suffix}` } }))).toBe(0);
    expect(await platformAdminTransaction((tx) => tx.store.findUniqueOrThrow({ where: { id: storeId }, select: { metroId: true } }))).toEqual({ metroId: null });
    expect(await metroAudit()).toHaveLength(audits);
  });

  it("RLS: outside the platform-admin context, app_user reads metros but cannot write them", async () => {
    const id = metroIds[0];
    const asAppUser = <T,>(fn: (tx: Parameters<Parameters<typeof authPrisma.$transaction>[0]>[0]) => Promise<T>) =>
      authPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
        return fn(tx);
      });
    expect(await asAppUser((tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM metros WHERE id = ${id}`)).toEqual([{ id }]);
    expect(await asAppUser((tx) => tx.$executeRaw`UPDATE metros SET courier_selection_mode = 'cheapest' WHERE id = ${id}`)).toBe(0);
    await expect(asAppUser((tx) => tx.$executeRaw`INSERT INTO metros (id, name, states, center_lat, center_lng, radius_mi) VALUES (${crypto.randomUUID()}, ${`Rogue ${suffix}`}, '{MD}', 39, -77, 10)`)).rejects.toThrow(/row-level security/);
  });
});
