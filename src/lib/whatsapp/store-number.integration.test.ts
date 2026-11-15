import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

// The Shopper assistant plugs in here (ADR-0010); a test makes it fail once.
vi.mock("./customer-handler", async (importOriginal) => {
  const real = await importOriginal<typeof import("./customer-handler")>();
  return { handleCustomerMessage: vi.fn(real.handleCustomerMessage) };
});

import { POST } from "@/app/api/webhooks/whatsapp/route";
import { auth } from "../auth";
import { authPrisma } from "../db";
import { handleCustomerMessage } from "./customer-handler";
import { WhatsAppApiError } from "./errors";
import { fakeWhatsAppProvider } from "./fake";
import { setWhatsAppProvider } from "./index";
import { signWhatsAppBody } from "./signature";
import { handleStoreInboundMessage } from "./store-inbound";
import {
  ALREADY_LINKED_ERROR,
  disconnectStoreNumber,
  getStoreNumber,
  LINK_FAILED_ERROR,
  linkStoreNumber,
  PLATFORM_NUMBER_ERROR,
} from "./store-number";
import { openBusinessToken } from "./token-box";
import type { InboundMessage } from "./webhook-payload";

const hasDb = !!process.env.DATABASE_URL;

const SECRET = "store-number-test-secret";
const PLATFORM_PHONE_ID = "5550009999";
const KEY = randomBytes(32).toString("base64");
const suffix = `${Date.now()}-swn`;
// Ids unique per run: phone_number_id is unique platform-wide.
const base = Number(String(Date.now()).slice(-9));
const PHONE_A = String(1_000_000_000 + base);
const PHONE_B = String(2_000_000_000 + base);
const PHONE_C = String(3_000_000_000 + base);
const WABA_A = String(4_000_000_000 + base);
const WABA_B = String(5_000_000_000 + base);
const PHONE_X = String(6_000_000_000 + base);
const PHONE_Y = String(7_000_000_000 + base);
const PHONE_R = String(8_000_000_000 + base);
const PHONE_S = String(9_000_000_000 + base);
const PHONE_T = String(9_100_000_000 + base);
const PHONE_U = String(9_200_000_000 + base);
const PHONE_V = String(9_300_000_000 + base);
const PHONE_W = String(9_400_000_000 + base);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

let seq = 0;
function text(body: string): InboundMessage {
  return { id: `wamid.swn-${suffix}-${++seq}`, from: "14045550123", fromUserId: null, type: "text", text: body, timestamp: null, replyId: null, inGroup: false };
}

async function asPlatformAdmin(fn: (tx: typeof authPrisma) => Promise<unknown>): Promise<void> {
  await authPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    await fn(tx as unknown as typeof authPrisma);
  });
}

async function rawRow(storeId: string): Promise<{ business_token: string | null; status: string } | undefined> {
  let row: { business_token: string | null; status: string } | undefined;
  await asPlatformAdmin(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ business_token: string | null; status: string }>>`
      SELECT business_token, status FROM store_whatsapp_numbers WHERE store_id = ${storeId}`;
    row = rows[0];
  });
  return row;
}

describe.skipIf(!hasDb)("store WhatsApp number (lane database)", () => {
  let storeA = "";
  let storeB = "";
  let actorId = "";
  const actorEmail = `swn-${suffix}@test.example`;

  beforeAll(async () => {
    const res = await auth.handler(new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: actorEmail, password: "StoreNumberPass-123!", name: "Ada" }),
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    actorId = (await authPrisma.user.findFirstOrThrow({ where: { email: actorEmail } })).id;
    storeA = crypto.randomUUID();
    storeB = crypto.randomUUID();
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeA}, 'Ada Market', ${`swn-a-${suffix}`}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeB}, 'Bola Market', ${`swn-b-${suffix}`}, 'active', now())`;
    });
  }, 60_000);

  beforeEach(() => {
    vi.stubEnv("WHATSAPP_APP_SECRET", SECRET);
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", PLATFORM_PHONE_ID);
    vi.stubEnv("WHATSAPP_TOKEN_KEY", KEY);
    setWhatsAppProvider(fakeWhatsAppProvider);
  });

  afterEach(() => {
    setWhatsAppProvider(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const actor = (storeId: string) => ({ storeId, actorId, actorEmail });

  async function newStore(name: string): Promise<string> {
    const id = crypto.randomUUID();
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${id}, ${name}, ${`swn-${id}`}, 'active', now())`;
    });
    return id;
  }

  it("links a number in fake mode: registered, coexistence on, token encrypted at rest and never in the view", async () => {
    const result = await linkStoreNumber(actor(storeA), {
      wabaId: WABA_A, phoneNumberId: PHONE_A, displayNumber: "(404) 555-0101", coexistence: true,
    });
    expect(result).toEqual({ ok: true });

    const view = await getStoreNumber(storeA);
    expect(view).toMatchObject({
      wabaId: WABA_A, phoneNumberId: PHONE_A, displayNumber: "+14045550101", status: "registered", coexistence: true,
    });
    expect(JSON.stringify(view)).not.toMatch(/token/i);

    const row = await rawRow(storeA);
    expect(row?.business_token).toBeTruthy();
    expect(row!.business_token).not.toContain("fake-business-token");
    expect(openBusinessToken(row!.business_token!, { storeId: storeA, phoneNumberId: PHONE_A })).toBe(`fake-business-token-${PHONE_A}`);
  });

  it("a phone number id linked at store A cannot be linked at store B, and A keeps it", async () => {
    expect(await linkStoreNumber(actor(storeA), {
      wabaId: WABA_A, phoneNumberId: PHONE_A, displayNumber: "(404) 555-0101", coexistence: true,
    })).toEqual({ ok: true });
    const taken = await linkStoreNumber(actor(storeB), {
      wabaId: WABA_B, phoneNumberId: PHONE_A, displayNumber: "+14045550102", coexistence: true,
    });
    expect(taken).toEqual({ error: ALREADY_LINKED_ERROR });
    expect(await getStoreNumber(storeB)).toBeNull();
    expect((await getStoreNumber(storeA))?.status).toBe("registered");

    expect(await linkStoreNumber(actor(storeB), {
      wabaId: WABA_B, phoneNumberId: PHONE_B, displayNumber: "+14045550102", coexistence: false,
    })).toEqual({ ok: true });
  });

  it("store B's session never reads, inserts, updates or deletes store A's row (RLS)", async () => {
    const asStoreB = <T,>(fn: (tx: typeof authPrisma) => Promise<T>) =>
      authPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.store_id', ${storeB}, true)`;
        return fn(tx as unknown as typeof authPrisma);
      });
    const seen = await asStoreB((tx) => tx.$queryRaw<Array<{ store_id: string }>>`SELECT store_id FROM store_whatsapp_numbers`);
    expect(seen).toEqual([{ store_id: storeB }]);

    await expect(asStoreB((tx) => tx.$executeRaw`
      INSERT INTO store_whatsapp_numbers (id, store_id, waba_id, phone_number_id, status)
      VALUES (${crypto.randomUUID()}, ${storeA}, ${WABA_B}, ${PHONE_C}, 'pending')`)).rejects.toThrow(/42501|row-level security/i);
    expect(await asStoreB((tx) => tx.$executeRaw`
      UPDATE store_whatsapp_numbers SET status = 'disconnected' WHERE store_id = ${storeA}`)).toBe(0);
    expect(await asStoreB((tx) => tx.$executeRaw`DELETE FROM store_whatsapp_numbers WHERE store_id = ${storeA}`)).toBe(0);
    expect((await getStoreNumber(storeA))?.status).toBe("registered");
  });

  it("refuses the platform number and malformed ids before any write", async () => {
    expect(await linkStoreNumber(actor(storeA), {
      wabaId: WABA_A, phoneNumberId: PLATFORM_PHONE_ID, displayNumber: "+14045550101", coexistence: true,
    })).toEqual({ error: PLATFORM_NUMBER_ERROR });
    const bad = await linkStoreNumber(actor(storeA), {
      wabaId: "12%", phoneNumberId: PHONE_A, displayNumber: "+14045550101", coexistence: true,
    });
    expect("error" in bad).toBe(true);
    expect((await getStoreNumber(storeA))?.phoneNumberId).toBe(PHONE_A);
  });

  it("routes a message to store A's number only to store A, B's only to B, a redelivery once, and drops an unknown number with a hashed log line", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const toA = text("hello A");
    expect(await handleStoreInboundMessage(PHONE_A, toA)).toEqual({ kind: "customer", storeId: storeA });
    expect(await handleStoreInboundMessage(PHONE_A, toA)).toEqual({ kind: "duplicate" });
    expect(await handleStoreInboundMessage(PHONE_B, text("hello B"))).toEqual({ kind: "customer", storeId: storeB });

    const unknown = text("who?");
    expect(await handleStoreInboundMessage(PHONE_C, unknown)).toEqual({ kind: "unknown_number" });
    const lines = info.mock.calls.map((call) => String(call[0]));
    const dropped = lines.find((line) => line.includes("whatsapp_inbound_unknown_number"));
    expect(dropped).toBeDefined();
    expect(dropped).not.toContain(PHONE_C);
    expect(dropped).not.toContain("14045550123");
    expect(JSON.parse(dropped!).number).toMatch(/^[0-9a-f]{12}$/);
    expect(lines.join("\n")).not.toContain("fake-business-token");
  });

  it("a customer handler failure throws and Meta's redelivery is handled, not dropped as a duplicate", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const message = text("handled on redelivery");
    vi.mocked(handleCustomerMessage).mockRejectedValueOnce(new Error("assistant down"));
    await expect(handleStoreInboundMessage(PHONE_A, message)).rejects.toThrow("assistant down");
    expect(await handleStoreInboundMessage(PHONE_A, message)).toEqual({ kind: "customer", storeId: storeA });
    expect(await handleStoreInboundMessage(PHONE_A, message)).toEqual({ kind: "duplicate" });
  });

  it("a signed webhook to store A's number reaches store A through the route", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const message = { from: "14045550123", id: `wamid.swn-route-${suffix}`, type: "text", text: { body: "hi" } };
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: WABA_A, changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE_A }, messages: [message] } }] }],
    });
    const res = await POST(new NextRequest("http://localhost:3000/api/webhooks/whatsapp", {
      method: "POST", body: raw,
      headers: { "content-type": "application/json", "x-hub-signature-256": signWhatsAppBody(raw, SECRET) },
    }));
    expect(res.status).toBe(200);
    const routed = info.mock.calls.map((call) => String(call[0])).find((line) => line.includes("whatsapp_customer_inbound"));
    expect(JSON.parse(routed!).storeId).toBe(storeA);
  });

  it("a provider failure leaves the row failed with the Graph code, and the number then routes nowhere", async () => {
    setWhatsAppProvider({
      send: fakeWhatsAppProvider.send,
      connectStoreNumber: () => Promise.reject(new WhatsAppApiError(100, 400)),
    });
    expect(await linkStoreNumber(actor(storeB), {
      wabaId: WABA_B, phoneNumberId: PHONE_B, displayNumber: "+14045550102", coexistence: true,
    })).toEqual({ error: LINK_FAILED_ERROR });
    expect(await getStoreNumber(storeB)).toMatchObject({ status: "failed", failureCode: "100" });
    expect((await rawRow(storeB))?.business_token).toBeNull();
    expect(await handleStoreInboundMessage(PHONE_B, text("x"))).toEqual({ kind: "unknown_number" });
  });

  it("disconnecting clears the token and stops routing", async () => {
    await disconnectStoreNumber(actor(storeA));
    expect(await getStoreNumber(storeA)).toMatchObject({ status: "disconnected" });
    expect((await rawRow(storeA))?.business_token).toBeNull();
    expect(await handleStoreInboundMessage(PHONE_A, text("x"))).toEqual({ kind: "unknown_number" });
  });

  it("refuses to link without the token key, before calling Meta", async () => {
    vi.stubEnv("WHATSAPP_TOKEN_KEY", "");
    const connect = vi.fn();
    setWhatsAppProvider({ send: fakeWhatsAppProvider.send, connectStoreNumber: connect });
    const result = await linkStoreNumber(actor(storeA), {
      wabaId: WABA_A, phoneNumberId: PHONE_A, displayNumber: "+14045550101", coexistence: true,
    });
    expect("error" in result).toBe(true);
    expect(connect).not.toHaveBeenCalled();
    expect((await getStoreNumber(storeA))?.status).toBe("disconnected");
  });

  it("a disconnected or failed row does not hold its number: another store can then link it", async () => {
    const [first, second] = [await newStore("Chidi Market"), await newStore("Dayo Market")];
    const ids = (phoneNumberId: string) => ({ wabaId: WABA_A, phoneNumberId, displayNumber: "+14045550103", coexistence: true });

    expect(await linkStoreNumber(actor(first), ids(PHONE_X))).toEqual({ ok: true });
    await disconnectStoreNumber(actor(first));
    expect(await linkStoreNumber(actor(second), ids(PHONE_X))).toEqual({ ok: true });
    expect(await getStoreNumber(second)).toMatchObject({ phoneNumberId: PHONE_X, status: "registered" });
    expect(await linkStoreNumber(actor(first), ids(PHONE_X))).toEqual({ error: ALREADY_LINKED_ERROR });

    setWhatsAppProvider({
      send: fakeWhatsAppProvider.send,
      connectStoreNumber: () => Promise.reject(new WhatsAppApiError(100, 400)),
    });
    expect(await linkStoreNumber(actor(second), ids(PHONE_Y))).toEqual({ error: LINK_FAILED_ERROR });
    setWhatsAppProvider(fakeWhatsAppProvider);
    expect(await linkStoreNumber(actor(first), ids(PHONE_Y))).toEqual({ ok: true });
    expect(await handleStoreInboundMessage(PHONE_Y, text("y"))).toEqual({ kind: "customer", storeId: first });
  });

  it("an overlapping retry of one link never reports success while the number is unlinked", async () => {
    const store = await newStore("Efe Market");
    const ids = { wabaId: WABA_A, phoneNumberId: PHONE_R, displayNumber: "+14045550104", coexistence: true };
    const calls = [deferred<{ businessToken: string; displayNumber: string }>(), deferred<{ businessToken: string; displayNumber: string }>()];
    let started = 0;
    setWhatsAppProvider({ send: fakeWhatsAppProvider.send, connectStoreNumber: () => calls[started++]!.promise });
    vi.spyOn(console, "info").mockImplementation(() => {});

    const first = linkStoreNumber(actor(store), ids);
    await until(() => started === 1);
    let secondDone = false;
    const second = linkStoreNumber(actor(store), ids).finally(() => { secondDone = true; });
    await until(() => started === 2 || secondDone);
    calls[0]!.reject(new WhatsAppApiError(100, 400));
    const firstResult = await first;
    calls[1]!.resolve({ businessToken: `token-${PHONE_R}`, displayNumber: "+14045550104" });
    const secondResult = await second;

    const status = (await getStoreNumber(store))?.status;
    const routed = await handleStoreInboundMessage(PHONE_R, text("r"));
    for (const result of [firstResult, secondResult]) {
      if ("ok" in result) {
        expect(status).toBe("registered");
        expect(routed).toEqual({ kind: "customer", storeId: store });
      }
    }
  });

  it("a second link while one is in flight gets the already-linked error; the first then links and routes", async () => {
    const store = await newStore("Funmi Market");
    const ids = { wabaId: WABA_A, phoneNumberId: PHONE_S, displayNumber: "+14045550105", coexistence: true };
    const call = deferred<{ businessToken: string; displayNumber: string }>();
    const connect = vi.fn(fakeWhatsAppProvider.connectStoreNumber).mockImplementationOnce(() => call.promise);
    setWhatsAppProvider({ send: fakeWhatsAppProvider.send, connectStoreNumber: connect });
    vi.spyOn(console, "info").mockImplementation(() => {});

    const first = linkStoreNumber(actor(store), ids);
    await until(() => connect.mock.calls.length === 1);
    expect(await linkStoreNumber(actor(store), ids)).toEqual({ error: ALREADY_LINKED_ERROR });
    expect(connect).toHaveBeenCalledTimes(1);

    call.resolve({ businessToken: `token-${PHONE_S}`, displayNumber: "+14045550105" });
    expect(await first).toEqual({ ok: true });
    expect(await getStoreNumber(store)).toMatchObject({ phoneNumberId: PHONE_S, status: "registered" });
    expect(await handleStoreInboundMessage(PHONE_S, text("s"))).toEqual({ kind: "customer", storeId: store });
  });

  it("a retry of a link that already succeeded returns ok with the same linked row and keeps its token, without calling Meta", async () => {
    const store = await newStore("Gbenga Market");
    const ids = { wabaId: WABA_A, phoneNumberId: PHONE_T, displayNumber: "+14045550106", coexistence: true };
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await linkStoreNumber(actor(store), ids)).toEqual({ ok: true });
    const before = await getStoreNumber(store);
    const token = (await rawRow(store))?.business_token;

    const connect = vi.fn(() => Promise.reject(new WhatsAppApiError(100, 400)));
    setWhatsAppProvider({ send: fakeWhatsAppProvider.send, connectStoreNumber: connect });
    expect(await linkStoreNumber(actor(store), ids)).toEqual({ ok: true });
    expect(connect).not.toHaveBeenCalled();
    expect(await getStoreNumber(store)).toEqual(before);
    expect((await rawRow(store))?.business_token).toBe(token);
    expect(await handleStoreInboundMessage(PHONE_T, text("t"))).toEqual({ kind: "customer", storeId: store });
  });

  it("two links started at once on a store with no number: one reaches Meta, the other gets the already-linked error", async () => {
    const store = await newStore("Halima Market");
    const ids = { wabaId: WABA_A, phoneNumberId: PHONE_U, displayNumber: "+14045550107", coexistence: true };
    // The winner stays in flight a moment, so the loser's begin overlaps it.
    const connect = vi.fn((input: Parameters<typeof fakeWhatsAppProvider.connectStoreNumber>[0]) =>
      new Promise((r) => setTimeout(r, 300)).then(() => fakeWhatsAppProvider.connectStoreNumber(input)));
    setWhatsAppProvider({ send: fakeWhatsAppProvider.send, connectStoreNumber: connect });
    vi.spyOn(console, "info").mockImplementation(() => {});

    const results = await Promise.all([linkStoreNumber(actor(store), ids), linkStoreNumber(actor(store), ids)]);
    expect(results).toContainEqual({ ok: true });
    expect(results).toContainEqual({ error: ALREADY_LINKED_ERROR });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(await handleStoreInboundMessage(PHONE_U, text("u"))).toEqual({ kind: "customer", storeId: store });
  });

  it("a link that completes after the number was disconnected meanwhile reports failure, not success", async () => {
    const store = await newStore("Jide Market");
    const call = deferred<{ businessToken: string; displayNumber: string }>();
    const connect = vi.fn(() => call.promise);
    setWhatsAppProvider({ send: fakeWhatsAppProvider.send, connectStoreNumber: connect });
    vi.spyOn(console, "info").mockImplementation(() => {});

    const link = linkStoreNumber(actor(store), { wabaId: WABA_A, phoneNumberId: PHONE_W, displayNumber: "+14045550109", coexistence: true });
    await until(() => connect.mock.calls.length === 1);
    await disconnectStoreNumber(actor(store));
    call.resolve({ businessToken: `token-${PHONE_W}`, displayNumber: "+14045550109" });
    expect(await link).toEqual({ error: LINK_FAILED_ERROR });
    expect(await getStoreNumber(store)).toMatchObject({ status: "disconnected" });
    expect(await handleStoreInboundMessage(PHONE_W, text("w"))).toEqual({ kind: "unknown_number" });
  });

  it("a pending row left by a link that died long ago does not block linking again", async () => {
    const store = await newStore("Ife Market");
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO store_whatsapp_numbers (id, store_id, waba_id, phone_number_id, status, updated_at)
        VALUES (${crypto.randomUUID()}, ${store}, ${WABA_A}, ${PHONE_V}, 'pending', (now() AT TIME ZONE 'UTC') - interval '10 minutes')`;
    });
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await linkStoreNumber(actor(store), {
      wabaId: WABA_A, phoneNumberId: PHONE_V, displayNumber: "+14045550108", coexistence: true,
    })).toEqual({ ok: true });
    expect(await getStoreNumber(store)).toMatchObject({ phoneNumberId: PHONE_V, status: "registered" });
  });
});
