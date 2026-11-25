import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";

const { fakeState } = vi.hoisted(() => ({
  fakeState: { fetch: (async () => new Response("unscripted", { status: 500 })) as typeof fetch },
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
}));
vi.mock("../assistant/model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assistant/model")>();
  return { ...actual, createAssistantModel: () => actual.createAssistantModel({ fetch: fakeState.fetch }) };
});

import { POST } from "@/app/api/webhooks/whatsapp/route";
import { testPrismaClient } from "@/lib/test-prisma";
import { createFakeAnthropicFetch, type FakeAnthropicStep } from "../assistant/messages-api-double";
import { setSpendClock } from "../assistant/spend";
import { platformAdmin, storeScoped } from "../db";
import { fakeWhatsAppProvider, getFakeOutbox, noteInbound, resetFake } from "./fake";
import { setWhatsAppProvider } from "./index";
import { setOwnerNotices } from "./owner-link";
import { PROPOSAL_GONE_REPLY, REJECTED_REPLY, TYPE_YOUR_REPORT_REPLY } from "./owner-handler";
import { signWhatsAppBody } from "./signature";
import type { OutboundMessage } from "./types";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t144-${Date.now().toString(36)}`;
const SECRET = "owner-copilot-secret";
const PHONE_NUMBER_ID = "5550144144";
const SPEND_DAY = new Date("2099-11-15T12:00:00.000Z");

function randomWaId(): string {
  return `1404${String(200 + Math.floor(Math.random() * 800))}${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
}

let seq = 0;

/** Meta delivering one message from `from` to the platform number. */
async function deliver(from: string, body: Record<string, unknown>, id = `wamid.${RUN}-${++seq}`): Promise<Response> {
  noteInbound(from);
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15550144144", phone_number_id: PHONE_NUMBER_ID },
          contacts: [{ profile: { name: "Owner" }, wa_id: from }],
          messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), ...body }],
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

const text = (from: string, body: string) => deliver(from, { type: "text", text: { body } });
const tap = (from: string, replyId: string, id?: string) =>
  deliver(from, { type: "interactive", interactive: { type: "button_reply", button_reply: { id: replyId, title: "x" } } }, id);

function sentTo(waId: string): OutboundMessage[] {
  return getFakeOutbox().map((entry) => entry.message).filter((message) => message.to === waId);
}

/** Replies are sent in order after the response. */
async function repliesTo(waId: string, count: number): Promise<OutboundMessage[]> {
  await vi.waitFor(() => expect(sentTo(waId).length).toBeGreaterThanOrEqual(count));
  return sentTo(waId);
}

function script(steps: FakeAnthropicStep[]) {
  const fake = createFakeAnthropicFetch({ expectedKey: "sk-ant-test", steps });
  fakeState.fetch = fake.fetch;
  return fake;
}

describe.skipIf(!hasDb)("Store copilot on WhatsApp (lane database, recording fake)", () => {
  let raw: PrismaClient;
  const ownerA = { id: `wa-owner-a-${RUN}`, waId: randomWaId() };
  const ownerB = { id: `wa-owner-b-${RUN}`, waId: randomWaId() };
  let storeA = "";
  let storeB = "";
  let egusiA = "";

  beforeAll(async () => {
    setSpendClock(() => SPEND_DAY);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("ASSISTANT_MODEL", "");
    vi.stubEnv("ASSISTANT_SPEND_CAP_USD", "1000000");
    vi.stubEnv("WHATSAPP_APP_SECRET", SECRET);
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", PHONE_NUMBER_ID);
    setWhatsAppProvider(fakeWhatsAppProvider);

    raw = testPrismaClient();
    storeA = (await raw.store.create({ data: { slug: `wa-cp-a-${RUN}`, name: "Ada Market" } })).id;
    storeB = (await raw.store.create({ data: { slug: `wa-cp-b-${RUN}`, name: "Bisi Foods" } })).id;
    // The chat is Pro (#818); WhatsApp runs the same chat.
    await platformAdmin.storeSubscription.createMany({ data: [storeA, storeB].map((storeId) => ({ storeId, plan: "pro", status: "active" })) });
    await raw.user.createMany({ data: [ownerA, ownerB].map((o) => ({ id: o.id, name: o.id, email: `${o.id}@example.com` })) });
    for (const [storeId, owner] of [[storeA, ownerA], [storeB, ownerB]] as const) {
      await storeScoped(storeId).storeMembership.create({ data: { storeId, userId: owner.id, role: "owner" } });
      await storeScoped(storeId).ownerWhatsAppLink.create({
        data: { storeId, userId: owner.id, phoneNumber: `+${owner.waId}`, waId: owner.waId, verified: true, verifiedAt: new Date() },
      });
    }
    egusiA = (await storeScoped(storeA).listing.create({
      data: { storeId: storeA, customName: "Egusi", price: 900, stockMode: "counted", qty: 4, confidence: 0.5 },
    })).id;
  });

  beforeEach(() => resetFake());

  afterAll(async () => {
    setWhatsAppProvider(null);
    setSpendClock(null);
    vi.unstubAllEnvs();
    await raw.$disconnect();
  });

  /** "restocked 20 bags of egusi" through the copilot's own tools; returns the proposal's buttons. */
  async function reportRestock(): Promise<{ confirm: string; reject: string; proposalId: string }> {
    const qty = (await storeScoped(storeA).listing.findUniqueOrThrow({ where: { id: egusiA } })).qty!;
    script([
      { kind: "tool", toolName: "find_listings", toolInput: { query: "egusi" } },
      { kind: "tool", toolName: "propose_stock_change", toolInput: { listingId: egusiA, kind: "restock", quantity: 20 } },
      { kind: "text", text: "Egusi can go up by 20." },
    ]);
    expect((await text(ownerA.waId, "restocked 20 bags of egusi")).status).toBe(200);
    const [reply, buttons] = await repliesTo(ownerA.waId, 2);
    expect(reply).toEqual({ type: "text", to: ownerA.waId, body: "Egusi can go up by 20." });
    expect(buttons?.type).toBe("interactive");
    if (buttons?.type !== "interactive") throw new Error("no buttons");
    expect(buttons.body).toContain(`Egusi: restock 20 (${qty} → ${qty + 20})`);
    expect(buttons.buttons.map((b) => b.title)).toEqual(["Confirm", "Reject"]);
    const proposal = await storeScoped(storeA).stockProposal.findFirstOrThrow({ where: { listingId: egusiA, state: "pending" } });
    return { confirm: buttons.buttons[0]!.id, reject: buttons.buttons[1]!.id, proposalId: proposal.id };
  }

  it("a text report proposes; Confirm writes one restock StockEvent and audit row as the owner, and a replayed or repeated tap writes nothing more", async () => {
    const { confirm, proposalId } = await reportRestock();
    expect((await storeScoped(storeA).listing.findUniqueOrThrow({ where: { id: egusiA } })).qty).toBe(4);
    const proposed = await storeScoped(storeA).auditLog.findMany({ where: { entityId: proposalId, action: "copilot.stock_proposed" } });
    expect(proposed).toHaveLength(1);

    resetFake();
    const tapId = `wamid.${RUN}-confirm`;
    expect((await tap(ownerA.waId, confirm, tapId)).status).toBe(200);
    expect(await repliesTo(ownerA.waId, 1)).toEqual([{ type: "text", to: ownerA.waId, body: "Done. Egusi is now 24 in stock." }]);
    expect((await tap(ownerA.waId, confirm, tapId)).status).toBe(200);
    expect((await tap(ownerA.waId, confirm)).status).toBe(200);
    await repliesTo(ownerA.waId, 2);

    expect((await storeScoped(storeA).listing.findUniqueOrThrow({ where: { id: egusiA } })).qty).toBe(24);
    const events = await storeScoped(storeA).stockEvent.findMany({ where: { listingId: egusiA } });
    expect(events).toMatchObject([{ type: "restock", delta: 20, actorId: ownerA.id, idempotencyKey: `copilot:${proposalId}` }]);
    const audit = await storeScoped(storeA).auditLog.findMany({ where: { entityId: egusiA, action: "listing.stock_change" } });
    expect(audit).toMatchObject([{ actorId: ownerA.id, before: { qty: 4 }, after: { qty: 24, source: "copilot", proposalId } }]);
    expect(await storeScoped(storeA).stockProposal.findUniqueOrThrow({ where: { id: proposalId } }))
      .toMatchObject({ kind: "restock", quantity: 20, before: { qty: 4 }, state: "confirmed", decidedById: ownerA.id });
  });

  it("Reject changes no stock, records the rejection, and acknowledges", async () => {
    const before = (await storeScoped(storeA).listing.findUniqueOrThrow({ where: { id: egusiA } })).qty;
    const { reject, proposalId } = await reportRestock();
    resetFake();
    expect((await tap(ownerA.waId, reject)).status).toBe(200);
    expect(await repliesTo(ownerA.waId, 1)).toEqual([{ type: "text", to: ownerA.waId, body: REJECTED_REPLY }]);
    expect((await storeScoped(storeA).listing.findUniqueOrThrow({ where: { id: egusiA } })).qty).toBe(before);
    expect(await storeScoped(storeA).auditLog.count({ where: { entityId: proposalId, action: "copilot.stock_rejected", actorId: ownerA.id } })).toBe(1);
    expect(await storeScoped(storeA).stockProposal.findUniqueOrThrow({ where: { id: proposalId } }))
      .toMatchObject({ state: "rejected", decidedById: ownerA.id });
  });

  it("store B's owner tapping store A's Confirm finds nothing and changes nothing", async () => {
    const { confirm, reject, proposalId } = await reportRestock();
    const before = (await storeScoped(storeA).listing.findUniqueOrThrow({ where: { id: egusiA } })).qty;
    expect((await tap(ownerB.waId, confirm)).status).toBe(200);
    expect((await tap(ownerB.waId, reject)).status).toBe(200);
    expect(await repliesTo(ownerB.waId, 2)).toEqual([
      { type: "text", to: ownerB.waId, body: PROPOSAL_GONE_REPLY },
      { type: "text", to: ownerB.waId, body: PROPOSAL_GONE_REPLY },
    ]);
    expect((await storeScoped(storeA).listing.findUniqueOrThrow({ where: { id: egusiA } })).qty).toBe(before);
    expect((await storeScoped(storeA).stockProposal.findUniqueOrThrow({ where: { id: proposalId } })).state).toBe("pending");
    expect(await storeScoped(storeB).stockProposal.count()).toBe(0);
    expect(await storeScoped(storeB).copilotConversation.count()).toBe(0);
  });

  it("WhatsApp gets no coupon, price or store-change draft tools: it cannot show the cards (#819)", async () => {
    const fake = script([{ kind: "text", text: "You can ask on the copilot page." }]);
    expect((await text(ownerA.waId, "10% off over $30 this weekend")).status).toBe(200);
    await repliesTo(ownerA.waId, 1);
    const names = ((fake.requests[0]?.body?.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain("find_listings");
    expect(names.filter((name) => name.startsWith("draft_"))).toEqual([]);
  });

  it("a voice note asks for text with no model call", async () => {
    const fake = script([]);
    expect((await deliver(ownerA.waId, { type: "audio", audio: { id: "media-1", mime_type: "audio/ogg" } })).status).toBe(200);
    expect(await repliesTo(ownerA.waId, 1)).toEqual([{ type: "text", to: ownerA.waId, body: TYPE_YOUR_REPORT_REPLY }]);
    expect(fake.requests).toHaveLength(0);
  });

  it("the owner's message moves the link's last inbound time, which alerts and the digest read for the 24-hour window", async () => {
    script([{ kind: "text", text: "Hello." }]);
    await text(ownerB.waId, "hello");
    const link = await storeScoped(storeB).ownerWhatsAppLink.findFirstOrThrow({ where: { userId: ownerB.id } });
    expect(link.lastInboundAt).not.toBeNull();
    expect(Math.abs(link.lastInboundAt!.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it("the owner turns alerts and the digest on for their own verified link only, with an audit row", async () => {
    const notices = { optInAlerts: true, optInDigest: true };
    expect(await setOwnerNotices({ storeId: storeA, userId: ownerA.id, actorEmail: "a@example.com" }, notices)).toBe(true);
    expect(await storeScoped(storeA).ownerWhatsAppLink.findFirstOrThrow({ where: { userId: ownerA.id } }))
      .toMatchObject(notices);
    expect(await storeScoped(storeA).auditLog.count({ where: { action: "whatsapp_link.notices", actorId: ownerA.id } })).toBe(1);
    // Store B's owner has no link at store A: nothing is written there.
    expect(await setOwnerNotices({ storeId: storeA, userId: ownerB.id, actorEmail: "b@example.com" }, notices)).toBe(false);
    expect(await storeScoped(storeB).ownerWhatsAppLink.findFirstOrThrow({ where: { userId: ownerB.id } }))
      .toMatchObject({ optInAlerts: false, optInDigest: false });
  });
});
