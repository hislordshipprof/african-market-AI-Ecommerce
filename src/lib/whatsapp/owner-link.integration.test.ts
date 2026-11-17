import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { generateTOTP } from "../../../e2e/totp";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { limiter } = vi.hoisted(() => ({ limiter: { fail: false } }));

vi.mock("../rate-limit/app-limiter", async (importOriginal) => {
  const original = await importOriginal<typeof import("../rate-limit/app-limiter")>();
  return {
    ...original,
    takeRateLimit: (...args: Parameters<typeof original.takeRateLimit>) =>
      limiter.fail ? Promise.reject(new Error("limiter down")) : original.takeRateLimit(...args),
  };
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
import { authPrisma, storeScoped } from "../db";
import { startWhatsAppLinkAction } from "./actions";
import { fakeWhatsAppProvider, getFakeOutbox, noteInbound, resetFake } from "./fake";
import { WhatsAppApiError } from "./errors";
import { NOT_LINKED_REPLY, WRONG_CODE_REPLY } from "./inbound";
import { UNAVAILABLE_MESSAGE } from "../copilot/types";
import { setWhatsAppProvider } from "./index";
import { getOwnerLink, NOT_SET_UP_ERROR, resolveOwnerByPhone, SEND_FAILED_ERROR } from "./owner-link";
import { signWhatsAppBody } from "./signature";
import type { OutboundMessage } from "./types";
import { authPost, testSignUp, collectCookies } from "../test-auth";

const hasDb = !!process.env.DATABASE_URL;

const SECRET = "owner-link-test-secret";
const PHONE_NUMBER_ID = "5550001234";
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

async function signUp(email: string, name: string): Promise<string> {
  const res = await testSignUp({ email, password, name });
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
/** Meta delivering messages: opens the 24-hour window for each phone sender, then posts one signed webhook. */
async function deliverMessages(
  contacts: Array<Record<string, unknown>>,
  messages: Array<Record<string, unknown>>,
): Promise<Response> {
  for (const message of messages) if (typeof message.from === "string") noteInbound(message.from);
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15550001234", phone_number_id: PHONE_NUMBER_ID },
          contacts,
          messages,
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

/** Meta delivering a text from `from`. */
async function deliverText(from: string, body: string, id = `wamid.in-${suffix}-${++messageSeq}`): Promise<Response> {
  return deliverMessages(
    [{ profile: { name: "Sender" }, wa_id: from }],
    [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
  );
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
  let cookiesB = "";
  const extraStores: string[] = [];

  /** Another store Ada owns, so a test gets its own five code sends an hour. */
  async function adaStore(): Promise<{ id: string; slug: string; name: string }> {
    const id = crypto.randomUUID();
    const slug = `wa-x${extraStores.length}-${suffix}`;
    const name = `Extra Market ${extraStores.length} ${suffix}`;
    extraStores.push(id);
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${id}, ${name}, ${slug}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${id}, ${ada}, 'owner', now())`;
    });
    headerState.set("cookie", cookiesA);
    headerState.set("x-store-slug", slug);
    return { id, slug, name };
  }

  async function signInWithTotp(email: string): Promise<string> {
    const signedIn = await authPost("/sign-in/email", { email, password });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const cookies = collectCookies(signedIn);
    const enabled = await authPost("/two-factor/enable", { password }, cookies);
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret");
    if (!secret) throw new Error("TOTP URI has no secret");
    const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
    expect(verified.status, await verified.clone().text()).toBe(200);
    return collectCookies(verified) || cookies;
  }

  /** The signed-in owner links `phone` at their store through the action and a signed reply. */
  async function linkAs(cookies: string, slug: string, phone: { typed: string; digits: string }): Promise<void> {
    headerState.set("cookie", cookies);
    headerState.set("x-store-slug", slug);
    expect(await startWhatsAppLinkAction(phoneForm(phone.typed))).toEqual({ ok: true });
    expect((await deliverText(phone.digits, lastCodeTo(phone.digits))).status).toBe(200);
  }

  beforeAll(async () => {
    ada = await signUp(emailA, "Ada");
    ownerB = await signUp(emailB, "Bola");
    cookiesA = await signInWithTotp(emailA);
    cookiesB = await signInWithTotp(emailB);

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
    // An owner's message runs the Store copilot (#144); with no model key it answers that it is unavailable.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", "owner-link-verify");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", PHONE_NUMBER_ID);
    setWhatsAppProvider(fakeWhatsAppProvider);
    resetFake();
    headerState.set("cookie", cookiesA);
    headerState.set("x-store-slug", slugA);
  });

  afterEach(() => {
    limiter.fail = false;
    setWhatsAppProvider(null);
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    const stores = [storeA, storeB, ...extraStores];
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`DELETE FROM owner_whatsapp_links WHERE store_id IN (${Prisma.join(stores)})`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id IN (${Prisma.join(stores)}) OR actor_id IN (${ada}, ${ownerB})`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE store_id IN (${Prisma.join(stores)})`;
      for (const userId of [ada, ownerB]) {
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id = ${userId}`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${userId}`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id = ${userId}`;
      }
      await tx.$executeRaw`DELETE FROM users WHERE id IN (${ada}, ${ownerB})`;
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${Prisma.join(stores)})`;
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
    // An expired code is no longer a candidate (F11): the sender gets the generic reply.
    expect(textsTo(phone.digits)).toEqual([NOT_LINKED_REPLY]);

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

  it("a pending code at another store does not capture a verified owner's messages; the right code still moves the number", async () => {
    const phone = randomUsNumber();
    await linkAs(cookiesA, slugA, phone);
    expect(await resolveOwnerByPhone(phone.e164)).toMatchObject({ storeId: storeA, userId: ada });

    // Store B's owner enters Ada's number.
    headerState.set("cookie", cookiesB);
    headerState.set("x-store-slug", slugB);
    expect(await startWhatsAppLinkAction(phoneForm(phone.typed))).toEqual({ ok: true });
    const codeB = lastCodeTo(phone.digits);
    const whereB = { storeId_userId: { storeId: storeB, userId: ownerB } };

    const other = codeB === "123456" ? "654321" : "123456";
    for (let i = 0; i < 6; i++) expect((await deliverText(phone.digits, other)).status).toBe(200);
    const texts = textsTo(phone.digits);
    expect(texts.slice(1)).toEqual(Array(6).fill(UNAVAILABLE_MESSAGE));
    const pendingB = await storeScoped(storeB).ownerWhatsAppLink.findUnique({ where: whereB });
    expect(pendingB).toMatchObject({ verified: false, verificationAttempts: 0 });
    expect(pendingB?.verificationCodeHash).not.toBeNull();
    expect(await resolveOwnerByPhone(phone.e164)).toMatchObject({ storeId: storeA, userId: ada });

    // The holder of the number replies with B's code: newest wins.
    expect((await deliverText(phone.digits, codeB)).status).toBe(200);
    expect(await resolveOwnerByPhone(phone.e164)).toEqual({ storeId: storeB, userId: ownerB, membership: { role: "owner" } });
    expect(await storeScoped(storeA).ownerWhatsAppLink.count()).toBe(0);
    await storeScoped(storeB).ownerWhatsAppLink.deleteMany({});
  });

  it("a failed send leaves the verified link as it was, for a new number and for the same number", async () => {
    // Store B: store A's five sends an hour are used by the tests above.
    const phone = randomUsNumber();
    await linkAs(cookiesB, slugB, phone);
    const where = { storeId_userId: { storeId: storeB, userId: ownerB } };
    const before = await storeScoped(storeB).ownerWhatsAppLink.findUnique({ where });
    expect(before?.verified).toBe(true);

    setWhatsAppProvider({
      ...fakeWhatsAppProvider,
      send: async () => { throw new WhatsAppApiError(130429, 429); },
    });
    for (const entered of [randomUsNumber().typed, phone.typed]) {
      expect(await startWhatsAppLinkAction(phoneForm(entered))).toEqual({ error: SEND_FAILED_ERROR });
      const after = await storeScoped(storeB).ownerWhatsAppLink.findUnique({ where });
      expect(after).toMatchObject({
        phoneNumber: before?.phoneNumber,
        waId: before?.waId,
        verified: true,
        verifiedAt: before?.verifiedAt,
        verificationCodeHash: null,
        verificationExpiresAt: null,
      });
      expect(await resolveOwnerByPhone(phone.e164)).toMatchObject({ storeId: storeB, userId: ownerB });
    }

    // A delivered code for a new number that is never answered also keeps the old link.
    setWhatsAppProvider(fakeWhatsAppProvider);
    const next = randomUsNumber();
    expect(await startWhatsAppLinkAction(phoneForm(next.typed))).toEqual({ ok: true });
    expect(await getOwnerLink(storeB, ownerB)).toMatchObject({ phoneNumber: phone.e164, verified: true, codeLive: true });
    expect(await resolveOwnerByPhone(phone.e164)).toMatchObject({ storeId: storeB, userId: ownerB });
    expect(await resolveOwnerByPhone(next.e164)).toBeNull();
  });

  it("no WhatsApp keys: start-link refuses with the not-set-up error, writes nothing and logs an error", async () => {
    setWhatsAppProvider(null);
    for (const key of ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "E2E_FAKE_WHATSAPP"]) vi.stubEnv(key, "");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = await storeScoped(storeA).ownerWhatsAppLink.findUnique({
      where: { storeId_userId: { storeId: storeA, userId: ada } },
    });

    expect(await startWhatsAppLinkAction(phoneForm(randomUsNumber().typed))).toEqual({ error: NOT_SET_UP_ERROR });
    expect(await storeScoped(storeA).ownerWhatsAppLink.findUnique({
      where: { storeId_userId: { storeId: storeA, userId: ada } },
    })).toEqual(before);
    expect(getFakeOutbox()).toHaveLength(0);
    expect(errorLog.mock.calls.flat().join(" ")).toContain("whatsapp_not_configured");
    errorLog.mockRestore();
  });

  it("a message without a phone number (username user) does not stop the other messages in the payload", async () => {
    const stranger = randomUsNumber();
    const bsuid = `US.${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const usernameId = `wamid.bsuid-${suffix}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await deliverMessages(
      [
        { profile: { name: "Username user" }, user_id: bsuid },
        { profile: { name: "Sender" }, wa_id: stranger.digits, user_id: `US.${stranger.digits}` },
      ],
      [
        { from_user_id: bsuid, id: usernameId, timestamp, type: "text", text: { body: "hello" } },
        { from: stranger.digits, from_user_id: `US.${stranger.digits}`, id: `wamid.in-${suffix}-${++messageSeq}`, timestamp, type: "text", text: { body: "hi" } },
      ],
    );
    expect(res.status).toBe(200);
    expect(textsTo(stranger.digits)).toEqual([NOT_LINKED_REPLY]);
    expect(getFakeOutbox()).toHaveLength(1);
    // The username message is still claimed, so a redelivery is not handled again.
    const claimed = await authPrisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM whatsapp_inbound_messages WHERE id = ${usernameId}`;
    expect(claimed).toHaveLength(1);
  });

  /** Meta delivering one message; `from` null is a username user known only by BSUID. */
  async function deliverFrom(
    sender: { digits: string | null; bsuid: string | null },
    message: Record<string, unknown>,
  ): Promise<Response> {
    if (sender.bsuid) noteInbound(sender.bsuid);
    return deliverMessages(
      [{ profile: { name: "Sender" }, ...(sender.digits ? { wa_id: sender.digits } : {}), ...(sender.bsuid ? { user_id: sender.bsuid } : {}) }],
      [{
        ...(sender.digits ? { from: sender.digits } : {}),
        ...(sender.bsuid ? { from_user_id: sender.bsuid } : {}),
        id: `wamid.in-${suffix}-${++messageSeq}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        ...message,
      }],
    );
  }

  function newBsuid(): string {
    return `US.${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  }

  it("the owner's BSUID is stored when they answer the code, and a later message with no phone number reaches them by BSUID", async () => {
    const store = await adaStore();
    const phone = randomUsNumber();
    const bsuid = newBsuid();
    expect(await startWhatsAppLinkAction(phoneForm(phone.typed))).toEqual({ ok: true });
    const code = lastCodeTo(phone.digits);
    expect((await deliverFrom({ digits: phone.digits, bsuid }, { type: "text", text: { body: code } })).status).toBe(200);
    const where = { storeId_userId: { storeId: store.id, userId: ada } };
    expect(await storeScoped(store.id).ownerWhatsAppLink.findUnique({ where })).toMatchObject({ verified: true, bsuid });

    // The owner adopts a username: Meta now sends only the BSUID.
    expect((await deliverFrom({ digits: null, bsuid }, { type: "text", text: { body: "how are sales?" } })).status).toBe(200);
    const toBsuid = getFakeOutbox().filter((entry) => entry.message.to === bsuid).map((entry) => entry.message);
    expect(toBsuid).toEqual([{ type: "text", to: bsuid, body: UNAVAILABLE_MESSAGE }]);

    // Another store's data never answers this BSUID.
    expect(await storeScoped(storeB).ownerWhatsAppLink.count({ where: { bsuid } })).toBe(0);
  });

  it("an owner verified before BSUIDs gets theirs recorded on their next message", async () => {
    const store = await adaStore();
    const phone = randomUsNumber();
    await linkAs(cookiesA, store.slug, phone);
    const where = { storeId_userId: { storeId: store.id, userId: ada } };
    expect((await storeScoped(store.id).ownerWhatsAppLink.findUnique({ where }))?.bsuid).toBeNull();

    const bsuid = newBsuid();
    expect((await deliverFrom({ digits: phone.digits, bsuid }, { type: "text", text: { body: "hello" } })).status).toBe(200);
    expect((await storeScoped(store.id).ownerWhatsAppLink.findUnique({ where }))?.bsuid).toBe(bsuid);
    expect((await deliverFrom({ digits: null, bsuid }, { type: "text", text: { body: "hello again" } })).status).toBe(200);
    expect(getFakeOutbox().filter((entry) => entry.message.to === bsuid)).toHaveLength(1);
  });

  it("an unlinked username user (BSUID only) is claimed and gets no reply", async () => {
    const bsuid = newBsuid();
    expect((await deliverFrom({ digits: null, bsuid }, { type: "text", text: { body: "123456" } })).status).toBe(200);
    expect(getFakeOutbox()).toHaveLength(0);
  });

  it("an owner demoted while a code is live cannot verify it, and gets the generic reply (F4)", async () => {
    const store = await adaStore();
    const phone = randomUsNumber();
    expect(await startWhatsAppLinkAction(phoneForm(phone.typed))).toEqual({ ok: true });
    const code = lastCodeTo(phone.digits);
    await asPlatformAdmin((tx) => tx.$executeRaw`
      UPDATE store_memberships SET role = 'staff' WHERE store_id = ${store.id} AND user_id = ${ada}`);

    expect((await deliverText(phone.digits, code)).status).toBe(200);
    const where = { storeId_userId: { storeId: store.id, userId: ada } };
    expect((await storeScoped(store.id).ownerWhatsAppLink.findUnique({ where }))?.verified).toBe(false);
    expect(textsTo(phone.digits)).toEqual([NOT_LINKED_REPLY]);
    const audit = await storeScoped(store.id).auditLog.count({ where: { action: "whatsapp_link.verify" } });
    expect(audit).toBe(0);
  });

  it("a verified owner who mistypes a code for their own link is told it is wrong, and no attempt is counted (F10)", async () => {
    const store = await adaStore();
    const phone = randomUsNumber();
    await linkAs(cookiesA, store.slug, phone);
    expect(await startWhatsAppLinkAction(phoneForm(phone.typed))).toEqual({ ok: true });
    const code = lastCodeTo(phone.digits);
    const wrong = code === "000000" ? "111111" : "000000";

    expect((await deliverText(phone.digits, wrong)).status).toBe(200);
    expect(textsTo(phone.digits).slice(1)).toEqual([WRONG_CODE_REPLY]);
    const where = { storeId_userId: { storeId: store.id, userId: ada } };
    expect(await storeScoped(store.id).ownerWhatsAppLink.findUnique({ where })).toMatchObject({
      verified: true,
      verificationAttempts: 0,
    });
    expect((await deliverText(phone.digits, code)).status).toBe(200);
    expect(textsTo(phone.digits).at(-1)).toBe(`Your number is now linked to ${store.name}.`);
  });

  it("a verified link is matched on wa_id only, never on the typed number (F8)", async () => {
    const store = await adaStore();
    const phone = randomUsNumber();
    const metaId = randomUsNumber();
    await linkAs(cookiesA, store.slug, phone);
    // Meta's send response gave a wa_id that differs from the typed digits.
    await asPlatformAdmin((tx) => tx.$executeRaw`
      UPDATE owner_whatsapp_links SET wa_id = ${metaId.digits} WHERE store_id = ${store.id} AND user_id = ${ada}`);

    expect(await resolveOwnerByPhone(phone.e164)).toBeNull();
    expect(await resolveOwnerByPhone(metaId.e164)).toMatchObject({ storeId: store.id, userId: ada });
  });

  it("an owner's edit, revoke, reaction or group message is claimed and gets no reply (F16)", async () => {
    const store = await adaStore();
    const phone = randomUsNumber();
    await linkAs(cookiesA, store.slug, phone);
    const before = textsTo(phone.digits).length;
    for (const message of [
      { type: "edit", edit: { original_message_id: "wamid.x" } },
      { type: "revoke", revoke: { original_message_id: "wamid.x" } },
      { type: "reaction", reaction: { message_id: "wamid.x", emoji: "👍" } },
      { type: "text", text: { body: "hi all" }, group_id: "120363000000000000" },
    ]) {
      expect((await deliverFrom({ digits: phone.digits, bsuid: null }, message)).status).toBe(200);
    }
    expect(textsTo(phone.digits)).toHaveLength(before);
    expect((await deliverText(phone.digits, "hello")).status).toBe(200);
    expect(textsTo(phone.digits).at(-1)).toBe(UNAVAILABLE_MESSAGE);
  });

  it("a reply rate-limit failure after the claim commits answers 200 and sends nothing (F5)", async () => {
    const stranger = randomUsNumber();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    limiter.fail = true;
    expect((await deliverText(stranger.digits, "hello")).status).toBe(200);
    expect(getFakeOutbox()).toHaveLength(0);
    expect(errorLog.mock.calls.flat().join(" ")).toContain("whatsapp_reply_rate_limit_failed");
    errorLog.mockRestore();
  });
});
