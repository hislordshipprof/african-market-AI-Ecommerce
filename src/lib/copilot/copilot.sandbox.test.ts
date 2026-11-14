import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authPrisma, storeScoped } from "../db";
import { setSpendClock } from "../assistant/spend";
import sharp from "sharp";
import { extractReportItems } from "./owner-report";
import { sendCopilotTurn } from "./turn";
import { liveSandbox, providerSandbox } from "../test-live-provider";

const DAY = "2099-11-08";
const live = process.env.ASSISTANT_LIVE_TESTS === "1"
  && !!process.env.DATABASE_URL
  && typeof process.env.ANTHROPIC_API_KEY === "string"
  && process.env.ANTHROPIC_API_KEY.trim() !== "";

const sandbox = providerSandbox("Anthropic");

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
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, ${"Live " + slug}, ${slug}, 'active', now())`;
    });
    gariId = await counted("Gari", 12);
    palmId = await counted("Palm oil", 7);
    riceId = await counted("Rice", 40);
  }), 30_000);

  afterAll(sandbox.hook(async () => {
    setSpendClock(null);
    if (!userId) return;
    await storeScoped(storeId).stockProposal.deleteMany({});
    await storeScoped(storeId).copilotClientMessage.deleteMany({});
    await storeScoped(storeId).copilotConversation.deleteMany({});
    await storeScoped(storeId).listing.deleteMany({});
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
