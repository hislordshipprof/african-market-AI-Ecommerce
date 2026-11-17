import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const sessions = vi.hoisted(() => ({
  owner: null as null | { storeId: string; userId: string; email: string },
  admin: null as null | { userId: string; email: string },
}));

vi.mock("../store-admin/session", () => ({
  requireStoreOwner: async () => {
    if (!sessions.owner) throw new Error("REDIRECT:/store-admin/sign-in");
    return { user: { id: sessions.owner.userId, email: sessions.owner.email }, store: { id: sessions.owner.storeId } };
  },
}));

vi.mock("../admin/session", () => ({
  requirePlatformAdmin: async () => {
    if (!sessions.admin) throw new Error("REDIRECT:/admin/sign-in");
    return { user: { id: sessions.admin.userId, email: sessions.admin.email, role: "platform_admin" } };
  },
}));

import { authPrisma } from "../db";
import { createTestUser } from "../test-auth";
import { fakeWhatsAppProvider } from "./fake";
import { setWhatsAppProvider } from "./index";
import { getStoreNumber } from "./store-number";
import {
  adminDisconnectStoreNumberAction,
  adminLinkStoreNumberAction,
  disconnectStoreNumberAction,
  linkStoreNumberAction,
} from "./store-number-actions";

const hasDb = !!process.env.DATABASE_URL;
const suffix = `${Date.now()}-swna`;
const base = Number(String(Date.now()).slice(-9));
const PHONE_A = String(6_000_000_000 + base);
const PHONE_B = String(7_000_000_000 + base);
const WABA = String(8_000_000_000 + base);

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe.skipIf(!hasDb)("store WhatsApp number actions (lane database)", () => {
  let storeA = "";
  let storeB = "";
  let userId = "";
  const email = `swna-${suffix}@test.example`;

  beforeAll(async () => {
    userId = await createTestUser({ email, password: "StoreNumberPass-123!", name: "Ada" });
    storeA = crypto.randomUUID();
    storeB = crypto.randomUUID();
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeA}, 'Ada Market', ${`swna-a-${suffix}`}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeB}, 'Bola Market', ${`swna-b-${suffix}`}, 'active', now())`;
    });
  }, 60_000);

  beforeEach(() => {
    vi.stubEnv("WHATSAPP_TOKEN_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "5550009999");
    setWhatsAppProvider(fakeWhatsAppProvider);
    sessions.owner = null;
    sessions.admin = null;
  });

  afterEach(() => {
    setWhatsAppProvider(null);
    vi.unstubAllEnvs();
  });

  it("the owner action links the session's store, ignoring a posted storeId, with coexistence on unless unticked", async () => {
    sessions.owner = { storeId: storeA, userId, email };
    const result = await linkStoreNumberAction(form({
      storeId: storeB, wabaId: WABA, phoneNumberId: PHONE_A, displayNumber: "+14045550101", coexistence: "on",
    }));
    expect(result).toEqual({ ok: true });
    expect(await getStoreNumber(storeA)).toMatchObject({ phoneNumberId: PHONE_A, status: "registered", coexistence: true });
    expect(await getStoreNumber(storeB)).toBeNull();
  });

  it("the owner can disconnect only their own store's number", async () => {
    sessions.owner = { storeId: storeB, userId, email };
    expect(await disconnectStoreNumberAction()).toEqual({ ok: true });
    expect((await getStoreNumber(storeA))?.status).toBe("registered");
  });

  it("the admin actions refuse a non-admin before any write, and link or disconnect the named store for an admin", async () => {
    const fields = { storeId: storeB, wabaId: WABA, phoneNumberId: PHONE_B, displayNumber: "+14045550102" };
    await expect(adminLinkStoreNumberAction(form(fields))).rejects.toThrow("REDIRECT");
    expect(await getStoreNumber(storeB)).toBeNull();

    sessions.admin = { userId, email };
    expect(await adminLinkStoreNumberAction(form({ ...fields, storeId: "no-such-store" }))).toEqual({ error: "Store not found" });
    expect(await adminLinkStoreNumberAction(form(fields))).toEqual({ ok: true });
    expect(await getStoreNumber(storeB)).toMatchObject({ phoneNumberId: PHONE_B, status: "registered", coexistence: false });

    expect(await adminDisconnectStoreNumberAction(form({ storeId: storeB }))).toEqual({ ok: true });
    expect((await getStoreNumber(storeB))?.status).toBe("disconnected");
    expect((await getStoreNumber(storeA))?.status).toBe("registered");
  });
});
