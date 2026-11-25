import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authPrisma, storeScoped } from "../db";
import { setSpendClock } from "../assistant/spend";
import sharp from "sharp";
import { extractReportItems } from "./owner-report";
import { sendCopilotTurn } from "./turn";
import { DRAFT_MAKERS } from "./drafts";
import { liveSandbox, providerSandbox } from "../test-live-provider";

const DAY = "2099-11-08";
const live = process.env.ASSISTANT_LIVE_TESTS === "1"
  && !!process.env.DATABASE_URL
  && typeof process.env.ANTHROPIC_API_KEY === "string"
  && process.env.ANTHROPIC_API_KEY.trim() !== "";

const sandbox = providerSandbox("Anthropic");
const WEEK = Object.fromEntries(
  ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => [day, "9:00 AM - 8:00 PM"]),
);

// sendCopilotTurn logs a refused model call instead of throwing it, so a logged 429 is rethrown for the sandbox.
async function turn(input: Parameters<typeof sendCopilotTurn>[0]) {
  const errors = vi.spyOn(console, "error");
  try {
    const sent = await sendCopilotTurn(input);
    const refused = errors.mock.calls.some(([, detail]) => (detail as { statusCode?: unknown } | undefined)?.statusCode === 429);
    if (!sent.ok && refused) throw Object.assign(new Error("Anthropic 429, logged by the copilot turn"), { statusCode: 429 });
    return sent;
  } finally {
    errors.mockRestore();
  }
}

async function dayCost(): Promise<bigint> {
  const found = await authPrisma.$queryRaw<Array<{ cost_micros: bigint }>>`
    SELECT cost_micros FROM assistant_spend_days WHERE day = CAST(${DAY} AS date)
  `;
  return found[0]?.cost_micros ?? BigInt(0);
}

describe.skipIf(!liveSandbox || !live)("copilot live sandbox", () => {
  const storeId = crypto.randomUUID();
  const slug = `copilot-live-${Date.now()}`;
  let userId = "";
  let gariId = "";
  let palmId = "";
  let riceId = "";
  const counted = async (name: string, qty: number) => (await storeScoped(storeId).listing.create({
    data: { storeId, customName: name, price: 500, stockMode: "counted", qty },
  })).id;

  beforeAll(sandbox.hook(async () => {
    setSpendClock(() => new Date(`${DAY}T12:00:00.000Z`));
    const user = await authPrisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `copilot-live-${Date.now()}@example.com`,
        name: "Live owner",
        emailVerified: true,
      },
    });
    userId = user.id;
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, hours, updated_at) VALUES (${storeId}, ${"Live " + slug}, ${slug}, 'active', ${JSON.stringify(WEEK)}::jsonb, now())`;
      // The chat is Pro (#818).
      await tx.storeSubscription.create({ data: { storeId, plan: "pro", status: "active" } });
    });
    gariId = await counted("Gari", 12);
    palmId = await counted("Palm oil", 7);
    riceId = await counted("Rice", 40);
  }), 30_000);

  afterAll(sandbox.hook(async () => {
    setSpendClock(null);
    if (!userId) return;
    await storeScoped(storeId).stockProposal.deleteMany({});
    await storeScoped(storeId).copilotDraft.deleteMany({});
    await storeScoped(storeId).copilotClientMessage.deleteMany({});
    await storeScoped(storeId).copilotConversation.deleteMany({});
    await storeScoped(storeId).order.deleteMany({});
    await storeScoped(storeId).customer.deleteMany({});
    await storeScoped(storeId).listingVariant.deleteMany({});
    await storeScoped(storeId).listing.deleteMany({});
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.storeSubscription.deleteMany({ where: { storeId } });
    });
    await authPrisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await authPrisma.store.delete({ where: { id: storeId } }).catch(() => undefined);
  }));

  it("live Haiku turns owner reports into the right proposals", sandbox.test(async () => {
    const before = await dayCost();
    const reports = [
      "got 20 bags of gari",
      "out of palm oil",
      "counted 15 bags of rice",
    ];
    for (const text of reports) {
      const sent = await turn({
        storeId,
        userId,
        email: "live@example.com",
        messageId: crypto.randomUUID(),
        text,
      });
      expect(sent.ok, JSON.stringify(sent)).toBe(true);
      if (sent.ok) expect(sent.proposals, sent.reply).toHaveLength(1);
    }
    const proposals = await storeScoped(storeId).stockProposal.findMany({ orderBy: { createdAt: "asc" } });
    expect(proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({ listingId: gariId, kind: "restock", quantity: 20, state: "pending" }),
      expect.objectContaining({ listingId: palmId, kind: "recount", quantity: 0, state: "pending" }),
      expect.objectContaining({ listingId: riceId, kind: "recount", quantity: 15, state: "pending" }),
    ]));
    for (const listingId of [gariId, palmId, riceId]) {
      expect(await storeScoped(storeId).stockEvent.count({ where: { listingId } })).toBe(0);
    }
    expect((await storeScoped(storeId).listing.findUniqueOrThrow({ where: { id: gariId } })).qty).toBe(12);
    expect((await storeScoped(storeId).listing.findUniqueOrThrow({ where: { id: palmId } })).qty).toBe(7);
    expect((await storeScoped(storeId).listing.findUniqueOrThrow({ where: { id: riceId } })).qty).toBe(40);

    const ofadaId = await counted("Ofada Rice", 9);
    const ambiguous = await turn({
      storeId,
      userId,
      email: "live@example.com",
      messageId: crypto.randomUUID(),
      text: "got 10 bags of rice",
    });
    expect(ambiguous.ok, JSON.stringify(ambiguous)).toBe(true);
    if (ambiguous.ok) {
      expect(ambiguous.proposals, ambiguous.reply).toHaveLength(0);
      expect(ambiguous.choices, ambiguous.reply).toHaveLength(1);
      expect(ambiguous.choices[0]!.candidates.map((candidate) => candidate.listingId).sort())
        .toEqual([ofadaId, riceId].sort());
      expect(ambiguous.choices[0]).toMatchObject({ kind: "restock", quantity: 10 });
    }
    expect(await storeScoped(storeId).stockProposal.count({ where: { listingId: ofadaId } })).toBe(0);

    const after = await dayCost();
    expect(after - before).toBeLessThan(BigInt(50_000));
  }), 120_000);

  it("live Haiku answers a sales question with the tool's figures and drafts nothing (#818)", sandbox.test(async () => {
    // Two pickup orders a minute ago: 3 × $12.50 egusi and 2 × $12.50 egusi. Goods $62.50, average $31.25.
    const db = storeScoped(storeId);
    const listing = await db.listing.create({ data: { storeId, customName: "Egusi", price: 1250, stockMode: "always" } });
    const variant = await db.listingVariant.create({ data: { listingId: listing.id, label: "1 lb", price: 1250, weightG: 450 } });
    const customer = await db.customer.create({ data: { storeId, name: "Live shopper" } });
    for (const [number, qty] of [[1, 3], [2, 2]] as const) {
      const cents = 1250 * qty;
      const order = await db.order.create({ data: {
        storeId, customerId: customer.id, number, fulfillment: "pickup", status: "COMPLETED", subtotalCents: cents, bufferCents: 0,
        totalAuthorizedCents: cents, capturedAmountCents: cents, platformFeeCents: 100, createdAt: new Date(Date.now() - 60_000),
      } });
      await db.orderLine.create({ data: { storeId, orderId: order.id, listingVariantId: variant.id, qtyOrdered: qty, qtyPicked: qty, unitPriceCents: 1250, status: "picked" } });
    }
    const sent = await turn({ storeId, userId, email: "live@example.com", messageId: crypto.randomUUID(), text: "how were sales today? what sold most?" });
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    if (!sent.ok) return;
    expect(sent.reply).toContain("62.50");
    expect(sent.reply).toMatch(/egusi/i);
    expect(sent.proposals).toEqual([]);
  }), 60_000);

  it("live Haiku drafts a coupon, a price change and a one-day closure, and writes none of them (#819)", sandbox.test(async () => {
    const db = storeScoped(storeId);
    const yam = await db.listing.create({
      data: { storeId, customName: "Yam", price: 300, stockMode: "counted", qty: 10, variants: { create: [{ label: "1 lb", price: 300, weightG: 450 }, { label: "5 lb", price: 1200, weightG: 2250 }] } },
    });
    const ask = async (text: string) => {
      const sent = await turn({ storeId, userId, email: "live@example.com", messageId: crypto.randomUUID(), text, drafts: DRAFT_MAKERS });
      expect(sent.ok, JSON.stringify(sent)).toBe(true);
      if (!sent.ok) throw new Error("turn failed");
      expect(sent.drafts, sent.reply).toHaveLength(1);
      return sent.drafts[0]!;
    };
    const coupon = await ask("10% off over $30 this weekend");
    expect(coupon.kind).toBe("coupon");
    if (coupon.kind === "coupon") expect(coupon.fields).toMatchObject({ kind: "percent", percentOff: "10", minGoods: "30.00" });
    const price = await ask("raise all yams by 50 cents");
    expect(price.kind).toBe("price");
    if (price.kind === "price") {
      expect(price.lines.map((line) => [line.listingId, line.beforeCents, line.afterCents]).sort()).toEqual([[yam.id, 1200, 1250], [yam.id, 300, 350]]);
    }
    const closed = await ask("we're closed tomorrow");
    expect(closed.kind).toBe("store_change");
    if (closed.kind === "store_change") expect(closed.text).toMatch(/^Closed all day/);
    expect(await db.storeCoupon.count()).toBe(0);
    expect((await db.listingVariant.findMany({ where: { listingId: yam.id } })).map((v) => v.price).sort()).toEqual([1200, 300]);
  }), 120_000);

  it("live vision reads an invoice photo into named lines with whole quantities", sandbox.test(async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><rect width="100%" height="100%" fill="white"/>
      <text x="24" y="60" font-family="Arial" font-size="32">INVOICE - Lagos Foods Supply</text>
      <text x="24" y="130" font-family="Arial" font-size="30">Egusi 5kg x 4</text>
      <text x="24" y="190" font-family="Arial" font-size="30">Palm Oil 1L x 6</text></svg>`;
    const image = await sharp(Buffer.from(svg)).jpeg().toBuffer();
    const { items } = await extractReportItems({ type: "invoice_photo", image });
    const byName = (word: string) => items.find((item) => item.name.toLowerCase().includes(word));
    expect(byName("egusi")?.quantity, JSON.stringify(items)).toBe(4);
    expect(byName("palm")?.quantity, JSON.stringify(items)).toBe(6);
  }), 60_000);
});
