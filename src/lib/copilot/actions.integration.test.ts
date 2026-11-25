import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState, fakeState, cache } = vi.hoisted(() => ({
  headerState: new Headers(),
  fakeState: { fetch: (async () => new Response("unscripted", { status: 500 })) as typeof fetch },
  cache: { revalidateTag: vi.fn() },
}));

vi.mock("next/headers", () => ({ headers: async () => headerState }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: (...args: unknown[]) => cache.revalidateTag(...args),
}));
vi.mock("../assistant/model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assistant/model")>();
  return {
    ...actual,
    createAssistantModel: () => actual.createAssistantModel({ fetch: fakeState.fetch }),
  };
});

import { generateTOTP } from "../../../e2e/totp";
import { createFakeAnthropicFetch, type FakeAnthropicStep } from "../assistant/messages-api-double";
import { setSpendClock } from "../assistant/spend";
import * as dbModule from "../db";
import type { Prisma } from "@prisma/client";
import { setStripeProvider } from "../stripe";
import { fakeStripeProvider } from "../stripe/fake";
import { authPrisma, platformAdmin, storeScoped, storeScopedTransaction, withSessionTimeZone } from "../db";
import { answerCopilotAlert, chooseProposalListing, confirmStockProposal, rejectStockProposal, sendCopilotMessage } from "./actions";
import { makeFakeStep } from "../inngest/fake-step";
import { runConfirmRequestSteps } from "./alert-functions";
import { FIXED_ERROR } from "./types";
import { NOTHING_DRAFTED, NUMBER_REFUSED, loadCopilotPanel } from "./turn";
import { saveReorder, updateReorderDays } from "./reorder-actions";
import { loadReorderList } from "./reorder-list";
import { authPost, testSignUp } from "../test-auth";

const RUN = `t142-${Date.now()}`;
const password = "Copilot-142-Owner!";
const hasDb = !!process.env.DATABASE_URL;
const SPEND_DAY = new Date("2099-11-07T12:00:00.000Z");

class CookieJar {
  private readonly jar = new Map<string, string>();

  apply(response: Response): void {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const semi = raw.indexOf(";");
      const pair = (semi === -1 ? raw : raw.slice(0, semi)).trim();
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

async function enableTwoFactor(email: string): Promise<string> {
  const jar = new CookieJar();
  const signedIn = await authPost("/sign-in/email", { email, password });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  jar.apply(signedIn);
  const enabled = await authPost("/two-factor/enable", { password }, jar.header());
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  jar.apply(enabled);
  const body = (await enabled.json()) as { totpURI?: string };
  const secret = new URL(body.totpURI ?? "http://localhost").searchParams.get("secret");
  expect(secret).toBeTruthy();
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret!) }, jar.header());
  expect(verified.status, await verified.clone().text()).toBe(200);
  jar.apply(verified);
  return jar.header();
}

function asStore(slug: string, cookies: string): void {
  headerState.set("cookie", cookies);
  headerState.set("x-store-slug", slug);
}

/** Pro by default: the chat is a Pro feature (#818). Null removes the subscription, which is Starter. */
async function setPlan(storeId: string, plan: "pro" | null): Promise<void> {
  await authPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    await tx.storeSubscription.deleteMany({ where: { storeId } });
    if (plan) await tx.storeSubscription.create({ data: { storeId, plan, status: "active" } });
  });
}

function script(steps: FakeAnthropicStep[]) {
  const fake = createFakeAnthropicFetch({ expectedKey: "sk-ant-test", steps });
  fakeState.fetch = fake.fetch;
  return fake;
}

describe.skipIf(!hasDb)("copilot actions (real auth, lane database)", () => {
  const storeAId = crypto.randomUUID();
  const storeBId = crypto.randomUUID();
  const storeASlug = `a-${RUN}`;
  const storeBSlug = `b-${RUN}`;
  const emailA = `owner-a-${RUN}@example.com`;
  const emailB = `owner-b-${RUN}@example.com`;
  const emailStaff = `staff-${RUN}@example.com`;
  let ownerAId = "";
  let cookiesA = "";
  let cookiesB = "";
  let cookiesStaff = "";
  let gariId = "";
  let riceId = "";
  let palmId = "";
  let egusiId = "";
  let yamId = "";

  beforeAll(async () => {
    setSpendClock(() => SPEND_DAY);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("ASSISTANT_MODEL", "");
    vi.stubEnv("ASSISTANT_SPEND_CAP_USD", "1000000");

    for (const [email, name] of [
      [emailA, "Owner A"],
      [emailB, "Owner B"],
      [emailStaff, "Staff A"],
    ] as const) {
      const res = await testSignUp({ email, password, name });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    ownerAId = (await authPrisma.user.findFirstOrThrow({ where: { email: emailA } })).id;
    const ownerBId = (await authPrisma.user.findFirstOrThrow({ where: { email: emailB } })).id;
    const staffId = (await authPrisma.user.findFirstOrThrow({ where: { email: emailStaff } })).id;

    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeAId}, ${"Copilot A " + RUN}, ${storeASlug}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeBId}, ${"Copilot B " + RUN}, ${storeBSlug}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeAId}, ${ownerAId}, 'owner', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeBId}, ${ownerBId}, 'owner', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeAId}, ${staffId}, 'staff', now())`;
    });

    await setPlan(storeAId, "pro");
    await setPlan(storeBId, "pro");

    const old = new Date("2020-01-01T00:00:00.000Z");
    const counted = async (name: string, qty: number) => {
      const listing = await storeScoped(storeAId).listing.create({
        data: {
          storeId: storeAId,
          customName: name,
          price: 500,
          stockMode: "counted",
          qty,
          confidence: 0.4,
          confidenceUpdatedAt: old,
        },
      });
      return listing.id;
    };
    gariId = await counted("Gari", 12);
    riceId = await counted("Rice", 40);
    palmId = await counted("Palm oil", 7);
    yamId = await counted("Yam", 5);
    egusiId = (await storeScoped(storeAId).listing.create({
      data: {
        storeId: storeAId,
        customName: "Egusi",
        price: 500,
        stockMode: "status",
        status: "in_stock",
        confidence: 0.4,
        confidenceUpdatedAt: old,
      },
    })).id;

    cookiesA = await enableTwoFactor(emailA);
    cookiesB = await enableTwoFactor(emailB);
    cookiesStaff = await enableTwoFactor(emailStaff);
  }, 90_000);

  afterAll(() => {
    setSpendClock(null);
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    asStore(storeASlug, cookiesA);
    cache.revalidateTag.mockClear();
  });

  it("an owner report becomes pending proposals and one tap writes exactly one stock change", async () => {
    const fake = script([
      { kind: "tool", toolName: "find_listings", toolInput: { query: "gari" } },
      { kind: "tool", toolName: "propose_stock_change", toolInput: { listingId: gariId, kind: "restock", quantity: 20 } },
      { kind: "tool", toolName: "find_listings", toolInput: { query: "egusi" } },
      { kind: "tool", toolName: "propose_stock_change", toolInput: { listingId: egusiId, kind: "set_status", status: "out_of_stock" } },
      { kind: "text", text: "Gari can go up by 20, and egusi is out." },
    ]);
    const sent = await sendCopilotMessage({
      messageId: crypto.randomUUID(),
      text: "got 20 bags of gari and we're out of egusi",
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        listingName: "Gari",
        kind: "restock",
        quantity: 20,
        beforeQty: 12,
        afterQty: 32,
        state: "pending",
      }),
      expect.objectContaining({
        listingName: "Egusi",
        kind: "set_status",
        statusValue: "out_of_stock",
        beforeStatus: "in_stock",
        afterStatus: "out_of_stock",
        state: "pending",
      }),
    ]));
    expect((await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: gariId } })).qty).toBe(12);
    expect(await storeScoped(storeAId).stockEvent.count({ where: { listingId: gariId } })).toBe(0);
    expect(await storeScoped(storeAId).stockEvent.count({ where: { listingId: egusiId } })).toBe(0);

    const names = ((fake.requests[0]?.body?.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name).sort();
    expect(names).toEqual(["find_listings", "inventory_report", "propose_stock_change", "reorder_suggestions", "sales_summary"]);
    const choice = fake.requests[0]?.body?.tool_choice;
    expect(choice == null || choice === "auto" || (typeof choice === "object" && (choice as { type?: string }).type === "auto")).toBe(true);

    const gari = sent.proposals.find((proposal) => proposal.listingId === gariId)!;
    const egusi = sent.proposals.find((proposal) => proposal.listingId === egusiId)!;
    const gariConfirmed = await confirmStockProposal({ proposalId: gari.id });
    const egusiConfirmed = await confirmStockProposal({ proposalId: egusi.id });
    expect(gariConfirmed).toMatchObject({ ok: true, listing: { qty: 32 } });
    expect(egusiConfirmed).toMatchObject({ ok: true, listing: { status: "out_of_stock" } });
    expect(cache.revalidateTag).toHaveBeenCalledWith(`storefront:${storeAId}`, { expire: 0 });

    const gariRow = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: gariId } });
    const egusiRow = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: egusiId } });
    expect(gariRow.confidence).toBe(1);
    expect(egusiRow.confidence).toBe(1);
    expect(gariRow.confidenceUpdatedAt.getTime()).toBeGreaterThan(new Date("2020-01-02").getTime());
    expect(egusiRow.confidenceUpdatedAt.getTime()).toBeGreaterThan(new Date("2020-01-02").getTime());

    const gariEvents = await storeScoped(storeAId).stockEvent.findMany({ where: { listingId: gariId } });
    const egusiEvents = await storeScoped(storeAId).stockEvent.findMany({ where: { listingId: egusiId } });
    expect(gariEvents).toEqual([expect.objectContaining({
      type: "restock",
      delta: 20,
      actorId: ownerAId,
      idempotencyKey: `copilot:${gari.id}`,
    })]);
    expect(egusiEvents).toEqual([expect.objectContaining({ type: "adjust", delta: 0, idempotencyKey: `copilot:${egusi.id}` })]);

    const stockAudits = await storeScoped(storeAId).auditLog.findMany({
      where: { action: "listing.stock_change", entityId: { in: [gariId, egusiId] } },
    });
    expect(stockAudits).toHaveLength(2);
    expect(stockAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: gariId, after: expect.objectContaining({ qty: 32, source: "copilot", proposalId: gari.id }) }),
      expect.objectContaining({ entityId: egusiId, after: expect.objectContaining({ status: "out_of_stock", source: "copilot", proposalId: egusi.id }) }),
    ]));
    const proposed = await storeScoped(storeAId).auditLog.count({
      where: { action: "copilot.stock_proposed", entityId: { in: [gari.id, egusi.id] } },
    });
    expect(proposed).toBe(2);

    const [again, other] = await Promise.all([
      confirmStockProposal({ proposalId: gari.id }),
      confirmStockProposal({ proposalId: gari.id }),
    ]);
    expect(again.ok).toBe(true);
    expect(other.ok).toBe(true);
    expect(await storeScoped(storeAId).stockEvent.count({ where: { listingId: gariId } })).toBe(1);
    expect(await storeScoped(storeAId).auditLog.count({
      where: { action: "listing.stock_change", entityId: gariId },
    })).toBe(1);
  }, 60_000);

  it("the chat is Pro: a Starter store keeps its history and pending changes but cannot send (#818)", async () => {
    const cassavaId = (await storeScoped(storeAId).listing.create({
      data: { storeId: storeAId, customName: "Cassava", price: 500, stockMode: "counted", qty: 5, confidence: 1 },
    })).id;
    let fake = script([
      { kind: "tool", toolName: "find_listings", toolInput: { query: "cassava" } },
      { kind: "tool", toolName: "propose_stock_change", toolInput: { listingId: cassavaId, kind: "restock", quantity: 3 } },
      { kind: "text", text: "Cassava can go up by 3." },
    ]);
    const sent = await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "got 3 cassava" });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    await setPlan(storeAId, null);
    try {
      fake = script([{ kind: "text", text: "Should not run." }]);
      const refused = await sendCopilotMessage({ conversationId: sent.conversationId, messageId: crypto.randomUUID(), text: "got 2 cassava" });
      expect(refused).toMatchObject({ ok: false, code: "plan_locked" });
      expect(fake.requests).toHaveLength(0);

      const panel = await loadCopilotPanel(storeAId, ownerAId);
      expect(panel.messages.map((message) => message.text)).toContain("got 3 cassava");
      expect(panel.messages.map((message) => message.text)).not.toContain("got 2 cassava");
      expect(await confirmStockProposal({ proposalId: sent.proposals[0].id })).toMatchObject({ ok: true, listing: { qty: 8 } });
    } finally {
      await setPlan(storeAId, "pro");
      await storeScoped(storeAId).listing.update({ where: { id: cassavaId }, data: { active: false } });
    }
  });

  it("sales_summary answers from the store's own orders for a period; a number it did not return is replaced (#818)", async () => {
    // Store B, New York. Hand-computed: O1 egusi 4×$5.00, tip $3.00, card fee 97¢, from the directory.
    // O2 palm oil 3×$15.00, card fee $1.60, refunded $10.00 two days later, no fee back.
    // Goods 2000 + 4500 = 6500, average 3250. Net 2300 − 97 + 4500 − 160 − 1000 = 5543.
    // An order the day after the range and a cancelled, uncaptured one in it are left out.
    const b = storeScoped(storeBId);
    const listing = async (name: string, price: number) => {
      const row = await b.listing.create({ data: { storeId: storeBId, customName: name, price, stockMode: "always" } });
      return (await b.listingVariant.create({ data: { listingId: row.id, label: "each", price, weightG: 500 } })).id;
    };
    const egusi = await listing("Egusi", 500);
    const palm = await listing("Palm oil", 1500);
    const customer = (await b.customer.create({ data: { storeId: storeBId, name: "Ada" } })).id;
    let number = 9000;
    const order = (data: Partial<Prisma.OrderUncheckedCreateInput> & { createdAt: Date }) =>
      b.order.create({ data: { storeId: storeBId, customerId: customer, number: ++number, subtotalCents: 0, bufferCents: 0, totalAuthorizedCents: 0, ...data } });
    const o1 = await order({ fulfillment: "pickup", status: "COMPLETED", tipCents: 300, capturedAmountCents: 2300, platformFeeCents: 97, acquisitionSource: "directory", createdAt: new Date("2026-10-06T16:00:00Z") });
    await b.orderLine.create({ data: { storeId: storeBId, orderId: o1.id, listingVariantId: egusi, qtyOrdered: 4, qtyPicked: 4, unitPriceCents: 500, status: "picked" } });
    const o2 = await order({ fulfillment: "pickup", status: "COMPLETED", capturedAmountCents: 4500, platformFeeCents: 160, createdAt: new Date("2026-10-07T16:00:00Z") });
    await b.orderLine.create({ data: { storeId: storeBId, orderId: o2.id, listingVariantId: palm, qtyOrdered: 3, qtyPicked: 3, unitPriceCents: 1500, status: "picked" } });
    await b.refundRequest.create({ data: { storeId: storeBId, orderId: o2.id, paymentIntentId: `pi_${RUN}_b2`, key: `${RUN}-b2`, amountCents: 1000, refundApplicationFee: false, state: "CREATED", providerStatus: "succeeded", createdAt: new Date("2026-10-09T16:00:00Z") } });
    await order({ fulfillment: "pickup", status: "COMPLETED", capturedAmountCents: 9900, platformFeeCents: 300, createdAt: new Date("2026-10-12T16:00:00Z") });
    await order({ fulfillment: "pickup", status: "CANCELLED", createdAt: new Date("2026-10-08T16:00:00Z") });

    asStore(storeBSlug, cookiesB);
    const period = { period: "range", from: "2026-10-05", to: "2026-10-11" };
    let fake = script([
      { kind: "tool", toolName: "sales_summary", toolInput: period },
      { kind: "text", text: "October 5 to 11: 2 orders, $65.00 in goods sales and $55.43 net to store after $10.00 in refunds. Average order $32.50." },
    ]);
    const answered = await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "how were sales from oct 5 to oct 11?" });
    expect(answered).toMatchObject({
      ok: true,
      reply: "October 5 to 11: 2 orders, $65.00 in goods sales and $55.43 net to store after $10.00 in refunds. Average order $32.50.",
      proposals: [],
    });
    const result = JSON.parse(String((fake.requests.at(-1)?.body?.messages as Array<{ content: Array<{ type: string; content?: string }> }>)
      .flatMap((message) => message.content).find((part) => part.type === "tool_result")?.content));
    expect(result).toMatchObject({
      from: "2026-10-05",
      to: "2026-10-11",
      timeZone: "America/New_York",
      orders: 2,
      goodsSales: 65,
      unitsSold: 7,
      refunds: 10,
      netToStore: 55.43,
      averageOrder: 32.5,
      ordersFromDirectory: 1,
      topByQuantity: [{ name: "Egusi", units: 4, sales: 20 }, { name: "Palm oil", units: 3, sales: 45 }],
      topBySales: [{ name: "Palm oil", units: 3, sales: 45 }, { name: "Egusi", units: 4, sales: 20 }],
      payout: { known: false },
    });

    // With Stripe set up, the payout is the payouts arriving in the period (the fake has $58.84 on Nov 6 and $34.68 on Nov 13).
    await platformAdmin.store.update({ where: { id: storeBId }, data: { stripeAccountId: `acct_${RUN}` } });
    setStripeProvider(fakeStripeProvider);
    try {
      fake = script([
        { kind: "tool", toolName: "sales_summary", toolInput: { period: "range", from: "2026-11-01", to: "2026-11-10" } },
        { kind: "text", text: "Stripe paid out $58.84." },
      ]);
      expect(await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "what was my payout nov 1 to 10?" }))
        .toMatchObject({ ok: true, reply: "Stripe paid out $58.84." });
    } finally {
      setStripeProvider(null);
      await platformAdmin.store.update({ where: { id: storeBId }, data: { stripeAccountId: null } });
    }

    fake = script([
      { kind: "tool", toolName: "sales_summary", toolInput: period },
      { kind: "text", text: "You made about $70.00 in goods sales." },
    ]);
    const corrected = await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "how were sales from oct 5 to oct 11?" });
    expect(corrected).toMatchObject({
      ok: true,
      reply: "Oct 5 to Oct 11: 2 orders, $65.00 goods sales, $10.00 refunded, $55.43 net to store, average order $32.50.",
    });
  });

  it("a repeated message id returns the stored turn without a second model call", async () => {
    const messageId = crypto.randomUUID();
    const fake = script([
      { kind: "tool", toolName: "find_listings", toolInput: { query: "rice" } },
      { kind: "tool", toolName: "propose_stock_change", toolInput: { listingId: riceId, kind: "recount", quantity: 15 } },
      { kind: "text", text: "Rice counted to 15." },
    ]);
    const before = await storeScoped(storeAId).copilotConversation.count({ where: { userId: ownerAId } });
    const first = await sendCopilotMessage({ messageId, text: "counted 15 bags of rice" });
    expect(first.ok).toBe(true);
    const requests = fake.requests.length;
    const second = await sendCopilotMessage({ messageId, text: "counted 15 bags of rice" });
    expect(second.ok).toBe(true);
    expect(fake.requests.length).toBe(requests);
    if (first.ok && second.ok) {
      expect(second.conversationId).toBe(first.conversationId);
      expect(second.proposals.map((proposal) => proposal.id)).toEqual(first.proposals.map((proposal) => proposal.id));
    }
    expect(await storeScoped(storeAId).copilotConversation.count({ where: { userId: ownerAId } })).toBe(before + 1);
    expect(await storeScoped(storeAId).stockProposal.count({ where: { clientMessageId: messageId } })).toBe(1);
  }, 60_000);

  it("stores each turn's cost on the reply and adds it to the conversation, for AI oversight (#544)", async () => {
    script([{ kind: "text", text: "Nothing to change.", inputTokens: 1000, outputTokens: 100 }]);
    const sent = await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "how is the shop" });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const row = await storeScoped(storeAId).copilotConversation.findUniqueOrThrow({ where: { id: sent.conversationId } });
    const stored = row.messages as Array<{ role: string; costMicros?: number }>;
    // Haiku 5.5: 1,000 input tokens at $0.10 per million and 100 output tokens at $0.50 per million.
    expect(stored.at(-1)).toMatchObject({ role: "assistant", costMicros: 150 });
    expect(stored.at(-2)?.costMicros).toBeUndefined();
    const previous = stored.slice(0, -2).filter((message) => message.role === "assistant");
    expect(previous.every((message) => typeof message.costMicros === "number")).toBe(true);
    expect(Number(row.costMicros)).toBeGreaterThanOrEqual(150);
    expect(row.tokensIn).toBeGreaterThanOrEqual(1000);
  }, 60_000);

  it("a model failure after a drafted proposal writes nothing", async () => {
    const messageId = crypto.randomUUID();
    const beforeAudit = await storeScoped(storeAId).auditLog.count({
      where: { storeId: storeAId, action: "copilot.stock_proposed" },
    });
    const fake = script([
      { kind: "tool", toolName: "find_listings", toolInput: { query: "yam" } },
      { kind: "tool", toolName: "propose_stock_change", toolInput: { listingId: yamId, kind: "restock", quantity: 3 } },
      { kind: "error" },
    ]);
    const failed = await sendCopilotMessage({ messageId, text: "got 3 yams" });
    expect(failed).toMatchObject({ ok: false, message: FIXED_ERROR });
    if (!failed.ok) expect(failed.code).not.toBe("busy");
    const afterFail = fake.requests.length;
    expect(afterFail).toBeGreaterThan(0);
    expect(await storeScoped(storeAId).stockProposal.count({ where: { listingId: yamId } })).toBe(0);
    expect(await storeScoped(storeAId).auditLog.count({
      where: { storeId: storeAId, action: "copilot.stock_proposed" },
    })).toBe(beforeAudit);
    expect((await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: yamId } })).qty).toBe(5);

    const again = await sendCopilotMessage({ messageId, text: "got 3 yams" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).not.toBe("busy");
    expect(fake.requests.length).toBeGreaterThan(afterFail);
  }, 60_000);

  it("refused confirmations change nothing", async () => {
    script([
      { kind: "tool", toolName: "find_listings", toolInput: { query: "palm" } },
      { kind: "tool", toolName: "propose_stock_change", toolInput: { listingId: palmId, kind: "restock", quantity: 4 } },
      { kind: "text", text: "Palm oil restock." },
    ]);
    const sent = await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "got 4 palm oil" });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const proposalId = sent.proposals[0]!.id;
    const eventsBefore = await storeScoped(storeAId).stockEvent.count({ where: { listingId: palmId } });
    const auditsBefore = await storeScoped(storeAId).auditLog.count({
      where: { action: "listing.stock_change", entityId: palmId },
    });

    asStore(storeASlug, cookiesStaff);
    await expect(confirmStockProposal({ proposalId })).rejects.toThrow(/NEXT_REDIRECT:/);
    await expect(rejectStockProposal({ proposalId })).rejects.toThrow(/NEXT_REDIRECT:/);
    await expect(sendCopilotMessage({ messageId: crypto.randomUUID(), text: "got 1 palm oil" })).rejects.toThrow(/NEXT_REDIRECT:/);

    asStore(storeBSlug, cookiesB);
    expect(await confirmStockProposal({ proposalId })).toEqual({ ok: false, code: "not_found" });

    asStore(storeASlug, cookiesA);
    expect((await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: palmId } })).qty).toBe(7);
    expect(await storeScoped(storeAId).stockEvent.count({ where: { listingId: palmId } })).toBe(eventsBefore);
    expect(await storeScoped(storeAId).auditLog.count({
      where: { action: "listing.stock_change", entityId: palmId },
    })).toBe(auditsBefore);
    expect((await storeScoped(storeAId).stockProposal.findUniqueOrThrow({ where: { id: proposalId } })).state).toBe("pending");

    await storeScopedTransaction(storeAId, (tx) => tx.$executeRaw`
      UPDATE stock_proposals
      SET expires_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '30 minutes'
      WHERE id = ${proposalId}
    `);
    const expired = await withSessionTimeZone("America/Denver", () => confirmStockProposal({ proposalId }));
    expect(expired).toEqual({ ok: false, code: "expired" });
    expect((await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: palmId } })).qty).toBe(7);
    expect(await storeScoped(storeAId).stockEvent.count({ where: { listingId: palmId } })).toBe(eventsBefore);

    script([
      { kind: "tool", toolName: "find_listings", toolInput: { query: "palm" } },
      { kind: "tool", toolName: "propose_stock_change", toolInput: { listingId: palmId, kind: "counter_sale", quantity: 1 } },
      { kind: "text", text: "One palm oil at the counter." },
    ]);
    const dismissable = await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "sold 1 palm oil at the counter" });
    expect(dismissable.ok).toBe(true);
    if (!dismissable.ok) return;
    const dismissedId = dismissable.proposals[0]!.id;
    expect(await rejectStockProposal({ proposalId: dismissedId })).toEqual({ ok: true });
    expect(await confirmStockProposal({ proposalId: dismissedId })).toEqual({ ok: false, code: "not_found" });
    expect((await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: palmId } })).qty).toBe(7);
    expect(await storeScoped(storeAId).stockEvent.count({ where: { listingId: palmId } })).toBe(eventsBefore);
    expect(await storeScoped(storeAId).auditLog.count({
      where: { action: "copilot.stock_rejected", entityId: dismissedId },
    })).toBe(1);

    script([
      { kind: "tool", toolName: "find_listings", toolInput: { query: "rice" } },
      { kind: "tool", toolName: "propose_stock_change", toolInput: { listingId: riceId, kind: "recount", quantity: 15 } },
      { kind: "text", text: "Rice to 15." },
    ]);
    const rice = await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "counted 15 bags of rice" });
    expect(rice.ok).toBe(true);
    if (!rice.ok) return;
    const riceIdProposal = rice.proposals[0]!.id;
    await storeScopedTransaction(storeAId, (tx) => tx.$executeRaw`
      UPDATE stock_proposals
      SET expires_at = (clock_timestamp() AT TIME ZONE 'UTC') + interval '30 minutes'
      WHERE id = ${riceIdProposal}
    `);
    const kept = await withSessionTimeZone("Europe/Berlin", () => confirmStockProposal({ proposalId: riceIdProposal }));
    expect(kept).toMatchObject({ ok: true, listing: { qty: 15 } });
    expect((await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: palmId } })).qty).toBe(7);
  }, 60_000);

  it("a listing that falls below 0.3 gets a confirm-request; only store A's owner can answer it, with one recount", async () => {
    const crayfishId = (await storeScoped(storeAId).listing.create({
      data: { storeId: storeAId, customName: "Crayfish", price: 500, stockMode: "counted", qty: 3, confidence: 0.25 },
    })).id;
    const lowAlert = await storeScoped(storeAId).copilotAlert.create({
      data: { storeId: storeAId, kind: "running_low", listingId: crayfishId, dedupeKey: `running_low:${crayfishId}:t430` },
    });
    const step = makeFakeStep();
    // Only this file's stores: a run over every store writes alerts for stores that parallel files are tearing down.
    const ownStoreIds = [storeAId, storeBId].sort();
    const spy = vi.spyOn(dbModule, "findStoreIdsAfter").mockImplementation(async (cursor) =>
      ownStoreIds.filter((id) => !cursor || id > cursor),
    );
    try {
      await runConfirmRequestSteps(step);
      await runConfirmRequestSteps(makeFakeStep());
    } finally {
      spy.mockRestore();
    }
    const requests = await storeScoped(storeAId).copilotAlert.findMany({
      where: { listingId: crayfishId, kind: "confirm_request" },
    });
    expect(requests).toHaveLength(1);
    // The daily run is at night in US zones: requests wait for the next order push or the digest.
    expect(step.runs.every((id) => id.startsWith("copilot-confirm-requests-"))).toBe(true);
    expect(requests[0]!.pushedAt).toBeNull();
    const alertId = requests[0]!.id;
    const stockChanges = () => storeScoped(storeAId).auditLog.count({
      where: { action: "listing.stock_change", entityId: crayfishId },
    });

    asStore(storeASlug, cookiesStaff);
    await expect(answerCopilotAlert({ alertId, answer: "still_have", qty: 8 })).rejects.toThrow(/NEXT_REDIRECT:/);
    asStore(storeBSlug, cookiesB);
    expect(await answerCopilotAlert({ alertId, answer: "still_have", qty: 8 })).toEqual({ ok: false, code: "not_found" });
    expect((await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: crayfishId } })).qty).toBe(3);
    expect(await storeScoped(storeAId).stockEvent.count({ where: { listingId: crayfishId } })).toBe(0);
    expect(await stockChanges()).toBe(0);
    expect((await storeScoped(storeAId).copilotAlert.findUniqueOrThrow({ where: { id: alertId } })).state).toBe("open");

    asStore(storeASlug, cookiesA);
    expect(await answerCopilotAlert({ alertId, answer: "still_have", qty: 8 })).toMatchObject({ ok: true, listing: { qty: 8 } });
    const listing = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: crayfishId } });
    expect([listing.qty, listing.confidence]).toEqual([8, 1]);
    const events = await storeScoped(storeAId).stockEvent.findMany({ where: { listingId: crayfishId } });
    expect(events.map((e) => [e.type, e.delta, e.actorId])).toEqual([["recount", 5, ownerAId]]);
    const audits = await storeScoped(storeAId).auditLog.findMany({
      where: { action: "listing.stock_change", entityId: crayfishId },
    });
    expect(audits.map((a) => a.actorId)).toEqual([ownerAId]);
    const alerts = await storeScoped(storeAId).copilotAlert.findMany({ where: { id: { in: [alertId, lowAlert.id] } } });
    expect(alerts.map((a) => [a.state, a.resolvedById])).toEqual([["resolved", ownerAId], ["resolved", ownerAId]]);
    expect(await storeScoped(storeAId).stockProposal.count({ where: { listingId: crayfishId } })).toBe(0);

    expect(await answerCopilotAlert({ alertId, answer: "still_have", qty: 2 })).toEqual({ ok: false, code: "not_found" });
    expect((await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: crayfishId } })).qty).toBe(8);
  }, 30_000);

  it("a report that fits two listings offers both and one tap drafts the chosen one", async () => {
    const ofadaId = (await storeScoped(storeAId).listing.create({
      data: { storeId: storeAId, customName: "Ofada Rice", price: 500, stockMode: "counted", qty: 9 },
    })).id;
    try {
      const riceQty = (await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: riceId } })).qty;
      const proposalsBefore = await storeScoped(storeAId).stockProposal.count({
        where: { listingId: { in: [riceId, ofadaId] } },
      });
      script([
        { kind: "tool", toolName: "find_listings", toolInput: { query: "rice" } },
        { kind: "tool", toolName: "propose_stock_change", toolInput: { listingId: riceId, kind: "restock", quantity: 10 } },
        { kind: "text", text: "Pick the rice below." },
      ]);
      const messageId = crypto.randomUUID();
      const sent = await sendCopilotMessage({ messageId, text: "got 10 bags of rice" });
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;
      expect(sent.proposals).toEqual([]);
      expect(sent.choices).toHaveLength(1);
      expect(sent.choices[0]).toMatchObject({ kind: "restock", quantity: 10, nearOnly: false, open: true });
      expect(sent.choices[0]!.candidates.map((candidate) => candidate.name).sort()).toEqual(["Ofada Rice", "Rice"]);
      expect(await storeScoped(storeAId).stockProposal.count({
        where: { listingId: { in: [riceId, ofadaId] } },
      })).toBe(proposalsBefore);

      const tap = { conversationId: sent.conversationId, messageId, listingId: ofadaId };
      expect(await chooseProposalListing({ ...tap, listingId: gariId })).toEqual({ ok: false, code: "not_found" });
      asStore(storeBSlug, cookiesB);
      expect(await chooseProposalListing(tap)).toEqual({ ok: false, code: "not_found" });
      asStore(storeASlug, cookiesA);

      const chosen = await chooseProposalListing(tap);
      expect(chosen).toMatchObject({
        ok: true,
        proposal: { listingId: ofadaId, kind: "restock", quantity: 10, beforeQty: 9, afterQty: 19, state: "pending" },
      });
      if (!chosen.ok) return;
      const again = await chooseProposalListing(tap);
      expect(again).toMatchObject({ ok: true, proposal: { id: chosen.proposal.id } });
      expect(await chooseProposalListing({ ...tap, listingId: riceId })).toEqual({ ok: false, code: "not_found" });
      expect(await storeScoped(storeAId).stockProposal.count({
        where: { listingId: { in: [riceId, ofadaId] } },
      })).toBe(proposalsBefore + 1);
      expect((await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: ofadaId } })).qty).toBe(9);
      expect((await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: riceId } })).qty).toBe(riceQty);
      expect(await storeScoped(storeAId).stockEvent.count({ where: { listingId: ofadaId } })).toBe(0);

      expect(await confirmStockProposal({ proposalId: chosen.proposal.id })).toMatchObject({ ok: true, listing: { qty: 19 } });
    } finally {
      await storeScoped(storeAId).listing.update({ where: { id: ofadaId }, data: { active: false } });
    }
  }, 60_000);

  it("a two-item report drafts the named item and offers the rest, in either order (#406)", async () => {
    const ofadaId = (await storeScoped(storeAId).listing.create({
      data: { storeId: storeAId, customName: "Ofada Rice", price: 500, stockMode: "counted", qty: 9 },
    })).id;
    const ofadaFirst: FakeAnthropicStep[] = [
      { kind: "tool", toolName: "find_listings", toolInput: { query: "ofada rice" } },
      { kind: "tool", toolName: "propose_stock_change", toolInput: { listingId: ofadaId, kind: "restock", quantity: 5 } },
      { kind: "tool", toolName: "find_listings", toolInput: { query: "rice" } },
      { kind: "tool", toolName: "propose_stock_change", toolInput: { listingId: riceId, kind: "restock", quantity: 10 } },
      { kind: "text", text: "Ofada up by 5. Pick the rice below." },
    ];
    const riceFirst = [...ofadaFirst.slice(2, 4), ...ofadaFirst.slice(0, 2), ofadaFirst[4]!];
    try {
      for (const steps of [ofadaFirst, riceFirst]) {
        script(steps);
        const messageId = crypto.randomUUID();
        const sent = await sendCopilotMessage({ messageId, text: "got 10 rice and 5 ofada rice" });
        expect(sent.ok).toBe(true);
        if (!sent.ok) return;
        expect(sent.proposals).toEqual([expect.objectContaining({ listingId: ofadaId, kind: "restock", quantity: 5 })]);
        expect(sent.choices).toHaveLength(1);
        expect(sent.choices[0]!.candidates.map((candidate) => candidate.listingId)).toEqual([riceId]);
        const chosen = await chooseProposalListing({ conversationId: sent.conversationId, messageId, listingId: riceId });
        expect(chosen).toMatchObject({ ok: true, proposal: { listingId: riceId, kind: "restock", quantity: 10 } });
      }
    } finally {
      await storeScoped(storeAId).listing.update({ where: { id: ofadaId }, data: { active: false } });
    }
  }, 60_000);

  it("a stale choice refuses the tap: expired, offered again later, a newer proposal, inactive or mode changed (#406)", async () => {
    const ofadaId = (await storeScoped(storeAId).listing.create({
      data: { storeId: storeAId, customName: "Ofada Rice", price: 500, stockMode: "counted", qty: 9 },
    })).id;
    const offer = async (conversationId?: string) => {
      script([
        { kind: "tool", toolName: "find_listings", toolInput: { query: "rice" } },
        { kind: "tool", toolName: "propose_stock_change", toolInput: { listingId: riceId, kind: "restock", quantity: 4 } },
        { kind: "text", text: "Pick the rice below." },
      ]);
      const messageId = crypto.randomUUID();
      const sent = await sendCopilotMessage({ conversationId, messageId, text: "got 4 rice" });
      if (!sent.ok) throw new Error(sent.code);
      expect(sent.choices).toHaveLength(1);
      return { conversationId: sent.conversationId, messageId };
    };
    const proposals = () => storeScoped(storeAId).stockProposal.count({ where: { listingId: { in: [riceId, ofadaId] } } });
    try {
      const expired = await offer();
      const row = await storeScoped(storeAId).copilotConversation.findUniqueOrThrow({ where: { id: expired.conversationId } });
      const aged = (row.messages as Array<{ choices?: Array<{ expiresAt: string }> }>).map((message) => ({
        ...message,
        ...(message.choices ? { choices: message.choices.map((choice) => ({ ...choice, expiresAt: "2000-01-01T00:00:00.000Z" })) } : {}),
      }));
      await storeScoped(storeAId).copilotConversation.update({ where: { id: expired.conversationId }, data: { messages: aged } });
      const before = await proposals();
      expect(await chooseProposalListing({ ...expired, listingId: riceId })).toEqual({ ok: false, code: "expired" });

      const first = await offer();
      const later = await offer(first.conversationId);
      expect(await chooseProposalListing({ ...first, listingId: riceId })).toEqual({ ok: false, code: "stale" });

      const old = await offer();
      script([
        { kind: "tool", toolName: "find_listings", toolInput: { query: "ofada rice" } },
        { kind: "tool", toolName: "propose_stock_change", toolInput: { listingId: ofadaId, kind: "recount", quantity: 15 } },
        { kind: "text", text: "Ofada counted at 15." },
      ]);
      const counted = await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "counted 15 ofada" });
      expect(counted).toMatchObject({ ok: true, proposals: [expect.objectContaining({ listingId: ofadaId })] });
      expect(await chooseProposalListing({ ...old, listingId: ofadaId })).toEqual({ ok: false, code: "stale" });
      expect(await proposals()).toBe(before + 1);

      await storeScoped(storeAId).listing.update({ where: { id: riceId }, data: { stockMode: "status", status: "in_stock" } });
      await storeScoped(storeAId).listing.update({ where: { id: ofadaId }, data: { active: false } });
      expect(await chooseProposalListing({ ...later, listingId: riceId })).toEqual({ ok: false, code: "stale" });
      expect(await chooseProposalListing({ ...later, listingId: ofadaId })).toEqual({ ok: false, code: "stale" });
      expect(await proposals()).toBe(before + 1);
    } finally {
      await storeScoped(storeAId).listing.update({ where: { id: riceId }, data: { stockMode: "counted", status: null } });
      await storeScoped(storeAId).listing.update({ where: { id: ofadaId }, data: { active: false } });
    }
  }, 60_000);

  it("a turn that uses every step but ends on its own does not say to send the rest (#406)", async () => {
    const search = { kind: "tool" as const, toolName: "find_listings", toolInput: { query: "gari" } };
    script([search, search, search, search, search, { kind: "text", text: "Gari is listed." }]);
    const sent = await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "do we have gari" });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.reply).not.toContain("Send the rest");

    script([search, search, search, search, search, search]);
    const cut = await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "do we have gari" });
    expect(cut.ok && cut.reply).toContain("Send the rest");
  }, 60_000);

  it("a text-only model turn drafts nothing", async () => {
    const before = await storeScoped(storeAId).stockProposal.count();
    script([{ kind: "text", text: "Which rice do you mean?" }]);
    const sent = await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "got 10 rice" });
    expect(sent).toMatchObject({ ok: true, proposals: [], choices: [] });
    expect(await storeScoped(storeAId).stockProposal.count()).toBe(before);
  }, 60_000);

  it("a specific name with look-alike neighbours drafts one card", async () => {
    const add = async (name: string) => (await storeScoped(storeAId).listing.create({
      data: { storeId: storeAId, customName: name, price: 500, stockMode: "counted", qty: 3 },
    })).id;
    const yellowId = await add("Yellow Garri 4lb");
    const others = [await add("Garri"), await add("White Garri")];
    try {
      script([
        { kind: "tool", toolName: "find_listings", toolInput: { query: "yellow garri" } },
        { kind: "tool", toolName: "propose_stock_change", toolInput: { listingId: yellowId, kind: "restock", quantity: 6 } },
        { kind: "text", text: "Yellow garri up by 6." },
      ]);
      const sent = await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "got 6 yellow garri" });
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;
      expect(sent.choices).toEqual([]);
      expect(sent.proposals).toEqual([
        expect.objectContaining({ listingId: yellowId, kind: "restock", quantity: 6, beforeQty: 3, afterQty: 9, state: "pending" }),
      ]);
      expect((await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: yellowId } })).qty).toBe(3);
    } finally {
      await storeScoped(storeAId).listing.updateMany({ where: { id: { in: [yellowId, ...others] } }, data: { active: false } });
    }
  }, 60_000);
  it("inventory_report figures can be quoted; a number no tool returned is replaced by the fixed summary or refused", async () => {
    const okraId = (await storeScoped(storeAId).listing.create({
      data: { storeId: storeAId, customName: "Okra", price: 500, stockMode: "counted", qty: 6, confidence: 1 },
    })).id;
    const day = 86_400_000;
    await storeScoped(storeAId).stockEvent.createMany({
      data: [
        { storeId: storeAId, listingId: okraId, type: "sale", delta: -10, actorId: ownerAId, createdAt: new Date(Date.now() - 2 * day) },
        { storeId: storeAId, listingId: okraId, type: "counter_sale", delta: -4, actorId: ownerAId, createdAt: new Date(Date.now() - day) },
      ],
    });
    const ask = async (text: string) => {
      const sent = await sendCopilotMessage({ messageId: crypto.randomUUID(), text });
      expect(sent.ok).toBe(true);
      return sent.ok ? sent : null;
    };

    script([
      { kind: "tool", toolName: "inventory_report", toolInput: { query: "okra" } },
      { kind: "text", text: "Okra sold 10 online and 4 at the counter this week, about 1 a day, so 6 days left." },
    ]);
    const quoted = await ask("how is okra selling?");
    expect(quoted?.reply).toBe(`Okra sold 10 online and 4 at the counter this week, about 1 a day, so 6 days left.\n\n${NOTHING_DRAFTED}`);
    expect(quoted?.proposals).toEqual([]);

    script([
      { kind: "tool", toolName: "inventory_report", toolInput: { query: "okra" } },
      { kind: "text", text: "Okra sold 18 this week, est. out Thursday." },
    ]);
    const corrected = await ask("how is okra selling?");
    expect(corrected?.reply).not.toContain("18");
    expect(corrected?.reply).toMatch(
      /^Okra: 10 sold online this week \(0 the week before\), 4 counter sales reported\. About 1 a day, 6 days left, est\. out [A-Z][a-z]+day\.\n\n/,
    );

    script([{ kind: "text", text: "Okra sells about 25 a week." }]);
    const refused = await ask("how is okra selling?");
    expect(refused?.reply).toBe(`${NUMBER_REFUSED}\n\n${NOTHING_DRAFTED}`);
    expect(await storeScoped(storeAId).stockEvent.count({ where: { listingId: okraId } })).toBe(2);
  });
  it("reorder suggestions: owner only, Pro only, the tool reads and orders nothing (#551)", async () => {
    const beansId = (await storeScoped(storeAId).listing.create({
      data: { storeId: storeAId, customName: "Beans", price: 500, stockMode: "counted", qty: 3, confidence: 1 },
    })).id;
    await storeScoped(storeAId).stockEvent.create({
      data: { storeId: storeAId, listingId: beansId, type: "sale", delta: -28, actorId: ownerAId, createdAt: new Date(Date.now() - 86_400_000) },
    });
    const ask = async () => {
      const sent = await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "what should I reorder?" });
      expect(sent.ok).toBe(true);
      return sent.ok ? sent : null;
    };
    const toolResult = (fake: ReturnType<typeof script>) => JSON.stringify(fake.requests.at(-1)?.body?.messages ?? []);
    const stock = async () => ({
      events: await storeScoped(storeAId).stockEvent.count(),
      beans: (await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: beansId } })).qty,
    });
    const before = await stock();

    // Starter: the actions refuse. The chat itself is Pro (#818), so the tool's locked answer is not reachable from it.
    await setPlan(storeAId, null);
    expect(await saveReorder({ lines: [{ listingId: beansId, quantity: 5 }] })).toEqual({ ok: false, message: "Reorder suggestions are on the Pro plan." });
    expect(await updateReorderDays({ leadDays: 3, coverDays: 7 })).toEqual({ ok: false, message: "Reorder suggestions are on the Pro plan." });
    await setPlan(storeAId, "pro");
    let fake: ReturnType<typeof script>;
    try {
      // Staff are refused even on Pro.
      asStore(storeASlug, cookiesStaff);
      await expect(saveReorder({ lines: [{ listingId: beansId, quantity: 5 }] })).rejects.toThrow(/NEXT_REDIRECT:/);
      await expect(updateReorderDays({ leadDays: 3, coverDays: 7 })).rejects.toThrow(/NEXT_REDIRECT:/);
      asStore(storeASlug, cookiesA);

      // 28 sold in 28 days is 1 a day; 21 days of need less 3 on hand is 18.
      fake = script([
        { kind: "tool", toolName: "reorder_suggestions", toolInput: {} },
        { kind: "text", text: "Reorder 18 Beans." },
      ]);
      const quoted = await ask();
      expect(toolResult(fake)).toContain(String.raw`{\"name\":\"Beans\",\"onHand\":3,\"soldLast28Days\":28,\"suggested\":18}`);
      expect(quoted?.reply).toBe(`Reorder 18 Beans.\n\n${NOTHING_DRAFTED}`);
      expect(quoted?.proposals).toEqual([]);

      expect(await updateReorderDays({ leadDays: 3.5, coverDays: 7 })).toMatchObject({ ok: false });
      expect(await updateReorderDays({ leadDays: 3, coverDays: 7 })).toEqual({ ok: true });
      expect(await saveReorder({ lines: [{ listingId: beansId, quantity: 7 }], extra: 1 })).toMatchObject({ ok: false });
      expect(await saveReorder({ lines: [{ listingId: beansId, quantity: 7 }] })).toEqual({ ok: true });
      expect((await loadReorderList(storeAId))?.items).toEqual([{ listingId: beansId, name: "Beans", quantity: 7 }]);

      // Store B's owner cannot save A's listing into B's list.
      asStore(storeBSlug, cookiesB);
      expect(await saveReorder({ lines: [{ listingId: beansId, quantity: 1 }] })).toMatchObject({ ok: false });
      asStore(storeASlug, cookiesA);

      expect(await stock()).toEqual(before);
    } finally {
      await storeScoped(storeAId).listing.update({ where: { id: beansId }, data: { active: false } });
    }
  });
});
