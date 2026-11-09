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
  revalidatePath: () => {},
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

import { updateStore } from "./actions";
import { fakeAddressBackend, setAddressProvider } from "../address/provider";
import { auth } from "../auth";
import { authPrisma, storeScopedTransaction } from "../db";

const BASE = "http://localhost:3000/api/auth";
const suffix = `${Date.now()}-hrs`;
const password = "GuardPass-123!";
const email = `hours-309-${suffix}@test.example`;
const slug = `hours-${suffix}`;

const overnight = { mon: "22:00-02:00", tue: "" };
const storedShape = {
  monday: "9:00 AM - 8:00 PM",
  tuesday: "9:00 AM - 8:00 PM",
  wednesday: "9:00 AM - 8:00 PM",
  thursday: "9:00 AM - 8:00 PM",
  friday: "9:00 AM - 9:00 PM",
  saturday: "8:00 AM - 9:00 PM",
  sunday: "10:00 AM - 6:00 PM",
};

function collectCookies(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).join("; ");
}

async function authPost(path: string, body: unknown, cookies?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies) headers.cookie = cookies;
  return auth.handler(new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

function storeForm(storeId: string, hours: unknown): FormData {
  const data = new FormData();
  data.set("storeId", storeId);
  data.set("slug", slug);
  data.set("name", "Hours 309");
  data.set("hours", JSON.stringify(hours));
  data.set("timezone", "America/Chicago");
  data.set("status", "active");
  data.set("themePreset", "palm-and-shea");
  data.set("prepTimeMinutes", "30");
  data.set("deliveryRadiusMi", "8");
  data.set("minimumOrder", "35");
  data.set("autoRefundLimit", "25");
  return data;
}

async function readHours(storeId: string): Promise<unknown> {
  const rows = await storeScopedTransaction(storeId, (tx) =>
    tx.$queryRaw<Array<{ hours: unknown }>>`SELECT hours FROM stores WHERE id = ${storeId}`,
  );
  return rows[0]?.hours;
}

describe("store hours schema", () => {
  let storeId = "";
  let userId = "";

  beforeAll(async () => {
    const signedUp = await authPost("/sign-up/email", { email, password, name: "Hours 309" });
    expect(signedUp.status, await signedUp.clone().text()).toBe(200);
    const user = await authPrisma.user.findFirstOrThrow({ where: { email } });
    userId = user.id;
    await authPrisma.user.update({ where: { id: userId }, data: { role: "platform_admin" } });
    const signedIn = await authPost("/sign-in/email", { email, password });
    const cookies = collectCookies(signedIn);
    const enabled = await authPost("/two-factor/enable", { password }, cookies);
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret");
    if (!secret) throw new Error("TOTP URI has no secret");
    const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
    expect(verified.status, await verified.clone().text()).toBe(200);
    headerState.set("cookie", collectCookies(verified) || cookies);
    storeId = crypto.randomUUID();
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, timezone, updated_at) VALUES (${storeId}, 'Hours 309', ${slug}, 'active', 'America/Chicago', now())`;
    });
  }, 60_000);

  afterAll(async () => {
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id = ${storeId}`;
      await tx.$executeRaw`DELETE FROM two_factors WHERE user_id = ${userId}`;
      await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${userId}`;
      await tx.$executeRaw`DELETE FROM accounts WHERE user_id = ${userId}`;
      await tx.$executeRaw`DELETE FROM verifications WHERE value LIKE ${"%" + email + "%"}`;
      await tx.$executeRaw`DELETE FROM users WHERE id = ${userId}`;
      await tx.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
    });
  });

  it("store hours schema accepts overnight and stored shapes", async () => {
    const overnightResult = await updateStore({}, storeForm(storeId, overnight));
    expect(overnightResult).toMatchObject({ success: true, storeId });
    expect(await readHours(storeId)).toEqual(overnight);

    const storedResult = await updateStore({}, storeForm(storeId, storedShape));
    expect(storedResult).toMatchObject({ success: true, storeId });
    expect(await readHours(storeId)).toEqual(storedShape);
  });

  it("platform admin turns on store delivery with a confirmed store address", async () => {
    setAddressProvider(fakeAddressBackend());
    const data = storeForm(storeId, storedShape);
    data.set("addressLine1", "4600 Silver Hill Rd");
    data.set("city", "Washington");
    data.set("state", "DC");
    data.set("zip", "20233");
    data.set("storeDeliveryFee", "5.00");
    data.set("storeDeliveryEnabled", "on");
    const saved = await updateStore({}, data);
    expect(saved).toMatchObject({ success: true, storeId });
    const store = await authPrisma.store.findUnique({ where: { id: storeId } });
    expect(store?.storeDeliveryEnabled).toBe(true);
    expect(store?.storeDeliveryFeeCents).toBe(500);
    expect(store?.lat).toBeCloseTo(38.845, 2);
    expect(store?.lng).toBeCloseTo(-76.928, 2);

    const bad = storeForm(storeId, storedShape);
    bad.set("addressLine1", "999 Imaginary Road");
    bad.set("city", "Nowhere");
    bad.set("state", "DC");
    bad.set("zip", "20233");
    bad.set("storeDeliveryFee", "5.00");
    bad.set("storeDeliveryEnabled", "on");
    const refused = await updateStore({}, bad);
    expect(refused.fieldErrors?.addressLine1).toBeTruthy();
    const still = await authPrisma.store.findUnique({ where: { id: storeId } });
    expect(still?.addressLine1).toBe("4600 Silver Hill Rd");
    expect(still?.lat).toBeCloseTo(38.845, 2);
    setAddressProvider(null);
  });

  it("turning on store delivery geocodes again when the saved address has no coordinates", async () => {
    const fake = fakeAddressBackend();
    setAddressProvider({ ...fake, locate: async () => ({ ok: false, code: "unavailable" }) });
    const off = storeForm(storeId, storedShape);
    off.set("addressLine1", "8505 Fenton St");
    off.set("city", "Silver Spring");
    off.set("state", "MD");
    off.set("zip", "20910");
    off.set("storeDeliveryFee", "5.00");
    expect(await updateStore({}, off)).toMatchObject({ success: true, storeId });
    const saved = await authPrisma.store.findUnique({ where: { id: storeId } });
    expect(saved?.addressLine1).toBe("8505 Fenton St");
    expect(saved?.lat).toBeNull();

    setAddressProvider(fake);
    const on = storeForm(storeId, storedShape);
    on.set("addressLine1", "8505 Fenton St");
    on.set("city", "Silver Spring");
    on.set("state", "MD");
    on.set("zip", "20910");
    on.set("storeDeliveryFee", "5.00");
    on.set("storeDeliveryEnabled", "on");
    expect(await updateStore({}, on)).toMatchObject({ success: true, storeId });
    const enabled = await authPrisma.store.findUnique({ where: { id: storeId } });
    expect(enabled?.storeDeliveryEnabled).toBe(true);
    expect(enabled?.lat).toBeCloseTo(38.996, 2);
    setAddressProvider(null);
  });
});
