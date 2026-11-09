import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
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

import { POST } from "@/app/api/webhooks/whatsapp/route";
import { auth } from "../auth";
import { authPrisma, storeScoped } from "../db";
import { startWhatsAppLinkAction } from "./actions";
import { fakeWhatsAppProvider, getFakeOutbox, noteInbound, resetFake } from "./fake";
import { NOT_LINKED_REPLY, WRONG_CODE_REPLY } from "./inbound";
import { setWhatsAppProvider } from "./index";
import { getOwnerLink, resolveOwnerByPhone } from "./owner-link";
import { signWhatsAppBody } from "./signature";
import type { OutboundMessage } from "./types";

const hasDb = !!process.env.DATABASE_URL;

const SECRET = "owner-link-test-secret";
const PHONE_NUMBER_ID = "5550001234";
const BASE = "http://localhost:3000/api/auth";
const suffix = `${Date.now()}-wa`;
const password = "WhatsAppPass-123!";
const emailA = `wa-a-${suffix}@test.example`;
const emailB = `wa-b-${suffix}@test.example`;
const slugA = `wa-a-${suffix}`;
const slugB = `wa-b-${suffix}`;
const storeNameA = `Ada Market ${suffix}`;

/** A fresh US number per run, so the per-number send limit never carries over between runs. */
function randomUsNumber(): { typed: string; e164: string; digits: string } {
  const exchange = String(200 + Math.floor(Math.random() * 800));
  const line = String(Math.floor(Math.random() * 10_000)).padStart(4, "0");
  const digits = `1404${exchange}${line}`;
  return { typed: `(404) ${exchange}-${line}`, e164: `+${digits}`, digits };
}

function collectCookies(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).join("; ");
}

async function authPost(path: string, body: unknown, cookies?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies) headers.cookie = cookies;
  return auth.handler(new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function signUp(email: string, name: string): Promise<string> {
  const res = await authPost("/sign-up/email", { email, password, name });
  expect(res.status, await res.clone().text()).toBe(200);
  const user = await authPrisma.user.findFirstOrThrow({ where: { email } });
  return user.id;
}

/** Test setup only: rows the app cannot write itself (memberships, a past expiry). */
async function asPlatformAdmin(fn: (tx: typeof authPrisma) => Promise<unknown>): Promise<void> {
  await authPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    await fn(tx as unknown as typeof authPrisma);
  });
}

let messageSeq = 0;

/** Meta delivering a text from `from`: opens the 24-hour window, then posts a signed webhook. */
async function deliverText(from: string, body: string, id = `wamid.in-${suffix}-${++messageSeq}`): Promise<Response> {
  noteInbound(from);
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15550001234", phone_number_id: PHONE_NUMBER_ID },
          contacts: [{ profile: { name: "Sender" }, wa_id: from }],
          messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
        },
      }],
    }],
  });
  return POST(new NextRequest("http://localhost:3000/api/webhooks/whatsapp", {
    method: "POST",
    body: raw,
    headers: { "content-type": "application/json", "x-hub-signature-256": signWhatsAppBody(raw, SECRET) },
  }));
}

function sentTo(digits: string): OutboundMessage[] {
  return getFakeOutbox().map((entry) => entry.message).filter((message) => message.to.replace(/^\+/, "") === digits);
}

function textsTo(digits: string): string[] {
  return sentTo(digits).flatMap((message) => (message.type === "text" ? [message.body] : []));
}

function lastCodeTo(digits: string): string {
  const templates = sentTo(digits).filter((message) => message.type === "template");
  const last = templates[templates.length - 1];
  if (!last || last.type !== "template") throw new Error("no code sent");
  const body = last.components?.find((component) => component.type === "body");
  const code = body?.parameters[0]?.text;
  if (!code) throw new Error("template has no code");
  return code;
}

function phoneForm(value: string): FormData {
  const form = new FormData();
  form.set("phone", value);
  return form;
}

describe.skipIf(!hasDb)("owner WhatsApp link (lane database)", () => {
  let storeA = "";
  let storeB = "";
  let ada = "";
  let ownerB = "";
  let cookiesA = "";

  beforeAll(async () => {
    ada = await signUp(emailA, "Ada");
    ownerB = await signUp(emailB, "Bola");
    const signedIn = await authPost("/sign-in/email", { email: emailA, password });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const cookies = collectCookies(signedIn);
    const enabled = await authPost("/two-factor/enable", { password }, cookies);
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret");
    if (!secret) throw new Error("TOTP URI has no secret");
    const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
    expect(verified.status, await verified.clone().text()).toBe(200);
    cookiesA = collectCookies(verified) || cookies;

    storeA = crypto.randomUUID();
    storeB = crypto.randomUUID();
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeA}, ${storeNameA}, ${slugA}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeB}, 'Bola Market', ${slugB}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeA}, ${ada}, 'owner', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeB}, ${ownerB}, 'owner', now())`;
    });
  }, 90_000);

  beforeEach(() => {
    vi.stubEnv("WHATSAPP_APP_SECRET", SECRET);
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", "owner-link-verify");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", PHONE_NUMBER_ID);
    setWhatsAppProvider(fakeWhatsAppProvider);
    resetFake();
    headerState.set("cookie", cookiesA);
    headerState.set("x-store-slug", slugA);
  });

  afterEach(() => {
    setWhatsAppProvider(null);
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`DELETE FROM owner_whatsapp_links WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id IN (${storeA}, ${storeB}) OR actor_id IN (${ada}, ${ownerB})`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE store_id IN (${storeA}, ${storeB})`;
      for (const userId of [ada, ownerB]) {
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id = ${userId}`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${userId}`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id = ${userId}`;
      }
      await tx.$executeRaw`DELETE FROM users WHERE id IN (${ada}, ${ownerB})`;
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${storeA}, ${storeB})`;
    });
  });

  it("cross-store read returns no rows and cross-store write raises 42501 on owner_whatsapp_links", async () => {
    const a = randomUsNumber();
    const b = randomUsNumber();
    const rowA = await storeScoped(storeA).ownerWhatsAppLink.create({
      data: { storeId: storeA, userId: ada, phoneNumber: a.e164, waId: a.digits },
    });
    const rowB = await storeScoped(storeB).ownerWhatsAppLink.create({
      data: { storeId: storeB, userId: ownerB, phoneNumber: b.e164, waId: b.digits },
    });

    const seenByA = await storeScoped(storeA).ownerWhatsAppLink.findMany();
    expect(seenByA.map((row) => row.id)).toEqual([rowA.id]);
    await expect(storeScoped(storeA).ownerWhatsAppLink.create({
      data: { storeId: storeB, userId: ownerB, phoneNumber: a.e164, waId: a.digits },
    })).rejects.toThrow(/42501|row-level security/i);
    const updated = await storeScoped(storeA).ownerWhatsAppLink.updateMany({
      where: { id: rowB.id },
      data: { verified: true },
    });
    expect(updated.count).toBe(0);
    const deleted = await storeScoped(storeA).ownerWhatsAppLink.deleteMany({ where: { id: rowB.id } });
    expect(deleted.count).toBe(0);
    const stillB = await storeScoped(storeB).ownerWhatsAppLink.findUnique({ where: { id: rowB.id } });
    expect(stillB?.verified).toBe(false);

    await storeScoped(storeA).ownerWhatsAppLink.deleteMany({});
    await storeScoped(storeB).ownerWhatsAppLink.deleteMany({});
  });

  it("owner links a number: the action sends a code, the signed webhook reply verifies it, resolveOwnerByPhone returns the store and owner membership; null before verification and for an unknown number", async () => {
    const phone = randomUsNumber();
    expect(await resolveOwnerByPhone(phone.e164)).toBeNull();

    expect(await startWhatsAppLinkAction(phoneForm(phone.typed))).toEqual({ ok: true });
    const sent = sentTo(phone.digits);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "template", name: "owner_link_code" });
    const code = lastCodeTo(phone.digits);
    expect(code).toMatch(/^\d{6}$/);

    const pending = await storeScoped(storeA).ownerWhatsAppLink.findUnique({
      where: { storeId_userId: { storeId: storeA, userId: ada } },
    });
    expect(pending).toMatchObject({ phoneNumber: phone.e164, verified: false, verifiedAt: null });
    expect(pending?.verificationCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pending?.verificationCodeHash).not.toContain(code);
    expect(await resolveOwnerByPhone(phone.e164)).toBeNull();

    const res = await deliverText(phone.digits, code);
    expect(res.status).toBe(200);

    const linked = await storeScoped(storeA).ownerWhatsAppLink.findUnique({
      where: { storeId_userId: { storeId: storeA, userId: ada } },
    });
    expect(linked?.verified).toBe(true);
    expect(linked?.verifiedAt).toBeInstanceOf(Date);
    expect(linked?.verificationCodeHash).toBeNull();
    expect(await getOwnerLink(storeA, ada)).toMatchObject({ phoneNumber: phone.e164, verified: true });
    expect(textsTo(phone.digits)).toEqual([`Your number is now linked to ${storeNameA}.`]);

    expect(await resolveOwnerByPhone(phone.e164)).toEqual({
      storeId: storeA,
      userId: ada,
      membership: { role: "owner" },
    });
    expect(await resolveOwnerByPhone(randomUsNumber().e164)).toBeNull();

    // Removing the owner's membership removes the link with it.
    await asPlatformAdmin((tx) => tx.$executeRaw`DELETE FROM store_memberships WHERE store_id = ${storeA} AND user_id = ${ada}`);
    expect(await resolveOwnerByPhone(phone.e164)).toBeNull();
    expect(await storeScoped(storeA).ownerWhatsAppLink.count()).toBe(0);
    await asPlatformAdmin((tx) => tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeA}, ${ada}, 'owner', now())`);
  });

  it("an expired code, or a code after five wrong attempts, does not verify", async () => {
    const phone = randomUsNumber();
    const where = { storeId_userId: { storeId: storeA, userId: ada } };

    expect(await startWhatsAppLinkAction(phoneForm(phone.e164))).toEqual({ ok: true });
    const expiredCode = lastCodeTo(phone.digits);
    await asPlatformAdmin((tx) => tx.$executeRaw`
      UPDATE owner_whatsapp_links SET verification_expires_at = (now() AT TIME ZONE 'UTC') - INTERVAL '1 minute'
      WHERE store_id = ${storeA} AND user_id = ${ada}`);
    expect((await deliverText(phone.digits, expiredCode)).status).toBe(200);
    expect((await storeScoped(storeA).ownerWhatsAppLink.findUnique({ where }))?.verified).toBe(false);
    expect(textsTo(phone.digits)).toEqual([WRONG_CODE_REPLY]);

    expect(await startWhatsAppLinkAction(phoneForm(phone.e164))).toEqual({ ok: true });
    const code = lastCodeTo(phone.digits);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await deliverText(phone.digits, wrong)).status).toBe(200);
    }
    const voided = await storeScoped(storeA).ownerWhatsAppLink.findUnique({ where });
    expect(voided).toMatchObject({ verified: false, verificationAttempts: 5, verificationCodeHash: null });

    expect((await deliverText(phone.digits, code)).status).toBe(200);
    const after = await storeScoped(storeA).ownerWhatsAppLink.findUnique({ where });
    expect(after?.verified).toBe(false);
    expect(after?.verifiedAt).toBeNull();
    expect(await resolveOwnerByPhone(phone.e164)).toBeNull();
  });

  it("an unlinked sender gets the generic reply with no store data, once for a duplicated delivery", async () => {
    // A pending link for this number must not change what the sender is told.
    const phone = randomUsNumber();
    expect(await startWhatsAppLinkAction(phoneForm(phone.typed))).toEqual({ ok: true });

    const id = `wamid.dup-${suffix}`;
    expect((await deliverText(phone.digits, "hello, which store is this?", id)).status).toBe(200);
    expect((await deliverText(phone.digits, "hello, which store is this?", id)).status).toBe(200);

    const replies = textsTo(phone.digits);
    expect(replies).toEqual([NOT_LINKED_REPLY]);
    expect(replies[0]).not.toContain(storeNameA);
    expect(replies[0]).not.toMatch(/pending|code|verify/i);
    expect((await storeScoped(storeA).ownerWhatsAppLink.findUnique({
      where: { storeId_userId: { storeId: storeA, userId: ada } },
    }))?.verified).toBe(false);
  });
});
