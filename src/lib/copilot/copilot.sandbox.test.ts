import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authPrisma, storeScoped } from "../db";
import { setSpendClock } from "../assistant/spend";
import { sendCopilotTurn } from "./turn";

const DAY = "2099-11-08";
const live = process.env.ASSISTANT_LIVE_TESTS === "1"
  && !!process.env.DATABASE_URL
  && typeof process.env.ANTHROPIC_API_KEY === "string"
  && process.env.ANTHROPIC_API_KEY.trim() !== "";

async function dayCost(): Promise<bigint> {
  const found = await authPrisma.$queryRaw<Array<{ cost_micros: bigint }>>`
    SELECT cost_micros FROM assistant_spend_days WHERE day = CAST(${DAY} AS date)
  `;
  return found[0]?.cost_micros ?? BigInt(0);
}

describe.skipIf(!live)("copilot live sandbox", () => {
  const storeId = crypto.randomUUID();
  const slug = `copilot-live-${Date.now()}`;
  let userId = "";
  let gariId = "";
  let palmId = "";
  let riceId = "";

  beforeAll(async () => {
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
    const counted = async (name: string, qty: number) => (await storeScoped(storeId).listing.create({
      data: { storeId, customName: name, price: 500, stockMode: "counted", qty },
    })).id;
    gariId = await counted("Gari", 12);
    palmId = await counted("Palm oil", 7);
    riceId = await counted("Rice", 40);
  }, 30_000);

  afterAll(async () => {
    setSpendClock(null);
    if (!userId) return;
    await storeScoped(storeId).stockProposal.deleteMany({});
    await storeScoped(storeId).copilotClientMessage.deleteMany({});
    await storeScoped(storeId).copilotConversation.deleteMany({});
    await storeScoped(storeId).listing.deleteMany({});
    await authPrisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await authPrisma.store.delete({ where: { id: storeId } }).catch(() => undefined);
  });

  it("drafts the three owner reports and spends under five cents", async () => {
    const before = await dayCost();
    const reports = [
      "got 20 bags of gari",
      "out of palm oil",
      "counted 15 bags of rice",
    ];
    let conversationId: string | undefined;
    for (const text of reports) {
      const sent = await sendCopilotTurn({
        storeId,
        userId,
        email: "live@example.com",
        conversationId,
        messageId: crypto.randomUUID(),
        text,
      });
      expect(sent.ok, JSON.stringify(sent)).toBe(true);
      if (sent.ok) conversationId = sent.conversationId;
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
    const after = await dayCost();
    expect(after - before).toBeLessThan(BigInt(50_000));
  }, 90_000);
});
