import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { authPrisma, storeScoped } from "../db";
import { E2E_FAKE_ANTHROPIC_KEY } from "../assistant/contract";
import { scriptedAssistantFetch } from "../assistant/fake-model";
import { createAssistantModel } from "../assistant/model";
import { ASSISTANT_CAP_MESSAGE, assistantChatUsage } from "../billing/assistant-chats";
import { assistantChatCap } from "../billing/plan";
import { fakeWhatsAppProvider, getFakeOutbox, noteInbound, resetFake } from "./fake";
import { setWhatsAppProvider } from "./index";
import { linkStoreNumber } from "./store-number";
import { shopperSenderKey } from "./token-box";
import { handleStoreInboundMessage } from "./store-inbound";
import { CHECKOUT_LINK_TTL_MS, redeemCheckoutLink } from "./checkout-link";
import { SHOPPER_TURNS_PER_HOUR, TYPE_YOUR_LIST_REPLY } from "./shopper";
import type { InboundMessage } from "./webhook-payload";

// The catalog search caches through Next; outside a request the cache is a pass-through.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
}));

const hasDb = !!process.env.DATABASE_URL;
const KEY = randomBytes(32).toString("base64");
const base = Number(String(Date.now()).slice(-9));
const PHONE_A = String(1_200_000_000 + base);
const PHONE_B = String(2_200_000_000 + base);
const WABA_A = String(4_200_000_000 + base);
const WABA_B = String(5_200_000_000 + base);
const LINK = /\/api\/checkout-link\/([A-Za-z0-9_-]{43})/;

let senderSeq = 0;
/** A fresh 11-digit wa_id per test, so rate rows and carts never cross tests. */
function newSender(): string {
  senderSeq += 1;
  return `1${String(base).padStart(9, "0").slice(-8)}${String(senderSeq).padStart(2, "0")}`;
}

let seq = 0;
function message(at: Date, from: string, fields: Partial<InboundMessage>): InboundMessage {
  return {
    id: `wamid.s559-${base}-${++seq}`,
    from,
    fromUserId: null,
    type: "text",
    text: null,
    timestamp: Math.floor(at.getTime() / 1000) - 5,
    replyId: null,
    ...fields,
  };
}

function recordingModel() {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = init?.body;
    requests.push(typeof body === "string" ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : "");
    return scriptedAssistantFetch(input, init);
  };
  return { model: createAssistantModel({ fetch: fetchImpl }), requests };
}

function sentTo(to: string) {
  return getFakeOutbox().filter((entry) => entry.message.to === to);
}

function texts(to: string): string[] {
  return sentTo(to).flatMap((entry) => (entry.message.type === "text" ? [entry.message.body] : []));
}

async function asPlatformAdmin<T>(fn: (tx: typeof authPrisma) => Promise<T>): Promise<T> {
  return authPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx as unknown as typeof authPrisma);
  });
}

describe.skipIf(!hasDb)("WhatsApp shopper conversations (#559)", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  const stores: string[] = [];
  const actorId = `s559-${base}`;
  const actorEmail = `${actorId}@example.com`;

  /** The cart this sender's chat with this store fills. */
  async function shopperCart(storeId: string, from: string): Promise<string | null> {
    const senderKey = shopperSenderKey(storeId, from);
    if (!senderKey) throw new Error("WHATSAPP_TOKEN_KEY is not set");
    const row = await storeScoped(storeId).whatsAppShopperCart.findUnique({
      where: { storeId_senderKey: { storeId, senderKey } },
    });
    return row?.cartId ?? null;
  }

  beforeAll(async () => {
    vi.stubEnv("WHATSAPP_TOKEN_KEY", KEY);
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    setWhatsAppProvider(fakeWhatsAppProvider);
    await raw.user.create({ data: { id: actorId, name: "Owner", email: actorEmail } });
    const make = (slug: string, name: string) => raw.store.create({
      data: {
        slug: `${slug}-${base}`,
        name,
        themePreset: "palm-and-shea",
        status: "active",
        timezone: "America/Chicago",
        pickupEnabled: true,
        minimumOrderCents: 0,
      },
    });
    storeA = (await make("s559a", "Ada's Market")).id;
    storeB = (await make("s559b", "Bola Market")).id;
    stores.push(storeA, storeB);
    const products: Array<[string, string, string, number]> = [
      [storeA, "Egusi Seeds", "1 lb", 1200],
      [storeA, "Yam Flour", "2 kg", 899],
      [storeA, "Yam Tuber", "1 tuber", 650],
      [storeB, "Plantain Chips", "bag", 300],
    ];
    for (const [storeId, name, label, price] of products) {
      const listing = await storeScoped(storeId).listing.create({
        data: { storeId, customName: name, price, stockMode: "unlimited", frozen: false, perishable: false },
      });
      await storeScoped(storeId).listingVariant.create({ data: { listingId: listing.id, label, price, weightG: 500 } });
    }
    for (const [storeId, wabaId, phoneNumberId] of [[storeA, WABA_A, PHONE_A], [storeB, WABA_B, PHONE_B]]) {
      expect(await linkStoreNumber({ storeId, actorId, actorEmail }, {
        wabaId, phoneNumberId, coexistence: true, displayNumber: "+1 404 555 0100",
      })).toEqual({ ok: true });
    }
    vi.unstubAllEnvs();
  }, 60_000);

  beforeEach(() => {
    vi.stubEnv("WHATSAPP_TOKEN_KEY", KEY);
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "markets.example");
    vi.stubEnv("ANTHROPIC_API_KEY", E2E_FAKE_ANTHROPIC_KEY);
    vi.stubEnv("E2E_FAKE_ASSISTANT", "1");
    vi.stubEnv("ASSISTANT_CHAT_ENABLED", "1");
    setWhatsAppProvider(fakeWhatsAppProvider);
    resetFake();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setWhatsAppProvider(null);
  });

  afterAll(async () => {
    for (const id of stores) {
      const scoped = storeScoped(id);
      await scoped.aiAction.deleteMany({});
      await scoped.aiConversation.deleteMany({});
      await scoped.cartLine.deleteMany({});
      await scoped.cart.deleteMany({});
      await scoped.listingVariant.deleteMany({});
      await scoped.listing.deleteMany({});
      await scoped.assistantChatMonth.deleteMany({});
      await scoped.auditLog.deleteMany({});
    }
    await asPlatformAdmin(async (tx) => {
      for (const id of stores) await tx.$executeRaw`DELETE FROM store_whatsapp_numbers WHERE store_id = ${id}`;
    });
    await raw.auditLog.deleteMany({ where: { storeId: { in: stores } } });
    await raw.store.deleteMany({ where: { id: { in: stores } } });
    await raw.user.deleteMany({ where: { id: actorId } });
    await raw.$disconnect();
  });

  it("a text runs the shopper assistant on a cart keyed to the sender at this store, and the number never reaches the model or the transcript", async () => {
    const now = new Date();
    const from = newSender();
    noteInbound(from);
    const { model, requests } = recordingModel();

    await handleStoreInboundMessage(PHONE_A, message(now, from, { text: "add two egusi" }), { model, now: () => now });
    await handleStoreInboundMessage(PHONE_A, message(now, from, { text: "hello" }), { model, now: () => now });

    expect(requests.length).toBeGreaterThan(0);
    expect(texts(from)).toEqual(["Here is what I found.", "Here is what I found."]);
    expect(sentTo(from).every((entry) => entry.from === PHONE_A)).toBe(true);

    const cartId = await shopperCart(storeA, from);
    expect(cartId).not.toBeNull();
    const lines = await storeScoped(storeA).cartLine.findMany({ where: { cartId: cartId! } });
    expect(lines.map((line) => line.qty)).toEqual([2]);
    const conversations = await storeScoped(storeA).aiConversation.findMany({ where: { cartId: cartId! } });
    expect(conversations).toHaveLength(1);
    const transcript = JSON.stringify(conversations[0].messages);
    expect((conversations[0].messages as Array<{ role: string }>).filter((entry) => entry.role === "user")).toHaveLength(2);

    const actions = JSON.stringify(await storeScoped(storeA).aiAction.findMany({ where: { conversationId: conversations[0].id } }));
    for (const seen of [...requests, transcript, actions]) {
      expect(seen).not.toContain(from);
      expect(seen).not.toContain(from.slice(1));
    }
  });

  it("choices go out as an interactive list drawn from the tool result, and a tapped row adds that product", async () => {
    const now = new Date();
    const from = newSender();
    noteInbound(from);
    const { model } = recordingModel();

    await handleStoreInboundMessage(PHONE_A, message(now, from, { text: "show me choices" }), { model, now: () => now });

    const list = sentTo(from).find((entry) => entry.message.type === "list")?.message;
    expect(list?.type).toBe("list");
    if (list?.type !== "list") throw new Error("no list");
    expect(list.rows.map((row) => [row.title, row.description]).sort()).toEqual([
      ["Yam Flour", "2 kg · $8.99"],
      ["Yam Tuber", "1 tuber · $6.50"],
    ]);

    const flour = list.rows.find((row) => row.title === "Yam Flour")!;
    await handleStoreInboundMessage(
      PHONE_A,
      message(now, from, { type: "interactive", replyId: flour.id }),
      { model, now: () => now },
    );
    const cartId = await shopperCart(storeA, from);
    const lines = await storeScoped(storeA).cartLine.findMany({
      where: { cartId: cartId! },
      include: { variant: { include: { listing: true } } },
    });
    expect(lines.map((line) => line.variant.listing.customName)).toEqual(["Yam Flour"]);
  });

  it("a price the tools never returned is cut from the WhatsApp reply by the grounder", async () => {
    const now = new Date();
    const from = newSender();
    noteInbound(from);
    const { model } = recordingModel();

    await handleStoreInboundMessage(PHONE_A, message(now, from, { text: "stray price" }), { model, now: () => now });

    const [reply] = texts(from);
    expect(reply).toBeDefined();
    expect(reply).not.toContain("$1.00");
  });

  it("checkout sends one link that opens this cart once, within 60 minutes, at this store only, and places no order", async () => {
    const now = new Date();
    const from = newSender();
    noteInbound(from);
    const { model } = recordingModel();
    const options = { model, now: () => now };

    await handleStoreInboundMessage(PHONE_A, message(now, from, { text: "add two egusi" }), options);
    await handleStoreInboundMessage(PHONE_A, message(now, from, { text: "I want to check out" }), options);

    const review = texts(from).find((body) => LINK.test(body));
    expect(review).toBeDefined();
    expect(review).toContain("https://s559a-");
    expect(review).toContain("$24.00");
    const token = LINK.exec(review!)![1];
    const cartId = await shopperCart(storeA, from);

    expect(await redeemCheckoutLink(storeB, token, null, now)).toEqual({ ok: false });
    expect(await redeemCheckoutLink(storeA, token, null, now)).toEqual({ ok: true, cartId });
    // Used once: another browser is refused; the browser that opened it already holds the cart.
    expect(await redeemCheckoutLink(storeA, token, "someone-else", now)).toEqual({ ok: false });
    expect(await redeemCheckoutLink(storeA, token, cartId, now)).toEqual({ ok: true, cartId });

    await handleStoreInboundMessage(PHONE_A, message(now, from, { text: "I want to check out" }), options);
    const second = texts(from).filter((body) => LINK.test(body)).at(-1)!;
    const fresh = LINK.exec(second)![1];
    expect(fresh).not.toBe(token);
    const late = new Date(now.getTime() + CHECKOUT_LINK_TTL_MS + 1000);
    expect(await redeemCheckoutLink(storeA, fresh, null, late)).toEqual({ ok: false });

    expect(await storeScoped(storeA).order.count({})).toBe(0);
  });

  it("a message older than the 24-hour window gets no reply and no model call", async () => {
    const now = new Date();
    const from = newSender();
    noteInbound(from);
    const { model, requests } = recordingModel();
    const old = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    const info = vi.spyOn(console, "info");

    await handleStoreInboundMessage(PHONE_A, message(old, from, { text: "add two egusi" }), { model, now: () => now });
    await handleStoreInboundMessage(PHONE_A, { ...message(now, from, { text: "rice" }), timestamp: null }, { model, now: () => now });

    expect(requests).toHaveLength(0);
    expect(sentTo(from)).toHaveLength(0);
    const logged = info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("whatsapp_shopper_outside_window"));
    expect(logged).toHaveLength(2);
    expect(logged.join("\n")).not.toContain(from);
    info.mockRestore();
  });

  it("images and voice notes are asked to type the list, with no model call", async () => {
    const now = new Date();
    const from = newSender();
    noteInbound(from);
    const { model, requests } = recordingModel();

    await handleStoreInboundMessage(PHONE_A, message(now, from, { type: "image" }), { model, now: () => now });
    await handleStoreInboundMessage(PHONE_A, message(now, from, { type: "audio" }), { model, now: () => now });

    expect(requests).toHaveLength(0);
    expect(texts(from)).toEqual([TYPE_YOUR_LIST_REPLY, TYPE_YOUR_LIST_REPLY]);
  });

  it(`stops at ${SHOPPER_TURNS_PER_HOUR} turns an hour per sender per store`, async () => {
    const now = new Date();
    const from = newSender();
    noteInbound(from);
    const { model, requests } = recordingModel();
    const options = { model, now: () => now };

    for (let turn = 0; turn < SHOPPER_TURNS_PER_HOUR; turn += 1) {
      await handleStoreInboundMessage(PHONE_A, message(now, from, { text: "hello" }), options);
    }
    const calls = requests.length;
    expect(texts(from)).toHaveLength(SHOPPER_TURNS_PER_HOUR);

    await handleStoreInboundMessage(PHONE_A, message(now, from, { text: "hello" }), options);
    expect(requests).toHaveLength(calls);
    expect(texts(from)).toHaveLength(SHOPPER_TURNS_PER_HOUR);

    // The same sender at another store has its own allowance.
    await handleStoreInboundMessage(PHONE_B, message(now, from, { text: "hello" }), options);
    expect(texts(from)).toHaveLength(SHOPPER_TURNS_PER_HOUR + 1);
  }, 120_000);

  it("a WhatsApp turn counts toward the store's monthly chats, and past the cap the model is not called", async () => {
    const now = new Date();
    const from = newSender();
    noteInbound(from);
    const { model, requests } = recordingModel();

    const before = await assistantChatUsage(storeB, "starter", now);
    await handleStoreInboundMessage(PHONE_B, message(now, from, { text: "hello" }), { model, now: () => now });
    const after = await assistantChatUsage(storeB, "starter", now);
    expect(after.chats).toBe(before.chats + 1);

    await storeScoped(storeB).assistantChatMonth.updateMany({ data: { chats: assistantChatCap("starter") } });
    const calls = requests.length;
    await handleStoreInboundMessage(PHONE_B, message(now, from, { text: "hello again" }), { model, now: () => now });
    expect(requests).toHaveLength(calls);
    expect(texts(from).at(-1)).toBe(ASSISTANT_CAP_MESSAGE);
    await storeScoped(storeB).assistantChatMonth.updateMany({ data: { chats: 0 } });
  });

  it("the same sender at two stores gets two carts, and store B's model never sees store A's basket", async () => {
    const now = new Date();
    const from = newSender();
    noteInbound(from);
    const atA = recordingModel();
    const atB = recordingModel();

    await handleStoreInboundMessage(PHONE_A, message(now, from, { text: "add two egusi" }), { model: atA.model, now: () => now });
    await handleStoreInboundMessage(PHONE_B, message(now, from, { text: "basket summary" }), { model: atB.model, now: () => now });

    const cartA = await shopperCart(storeA, from);
    const cartB = await shopperCart(storeB, from);
    expect(cartA).not.toBe(cartB);
    expect(await storeScoped(storeB).cart.findUnique({ where: { id: cartA! } })).toBeNull();
    expect(await storeScoped(storeB).cartLine.count({ where: { cartId: cartB! } })).toBe(0);
    expect(atB.requests.join("\n")).not.toContain("Egusi");
    expect(sentTo(from).map((entry) => entry.from)).toEqual([PHONE_A, PHONE_B]);
    const seenByB = await storeScoped(storeB).whatsAppShopperCart.findMany({ select: { storeId: true } });
    expect(seenByB.every((row) => row.storeId === storeB)).toBe(true);
  });

  it("a message that arrives while the previous turn is still running is released, so Meta's redelivery is handled", async () => {
    const now = new Date();
    const from = newSender();
    noteInbound(from);
    const { model } = recordingModel();
    const options = { model, now: () => now };

    await handleStoreInboundMessage(PHONE_A, message(now, from, { text: "hello" }), options);
    const cartId = await shopperCart(storeA, from);
    await storeScoped(storeA).aiConversation.updateMany({
      where: { cartId: cartId! },
      data: { inFlightUntil: new Date(Date.now() + 60_000) },
    });

    const second = message(now, from, { text: "add two egusi" });
    await expect(handleStoreInboundMessage(PHONE_A, second, options)).rejects.toThrow();
    await storeScoped(storeA).aiConversation.updateMany({ where: { cartId: cartId! }, data: { inFlightUntil: null } });
    expect(await handleStoreInboundMessage(PHONE_A, second, options)).toEqual({ kind: "customer", storeId: storeA });
    expect(texts(from)).toEqual(["Here is what I found.", "Here is what I found."]);
  });
});
