import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

vi.mock("next/headers", () => ({ headers: async () => headerState }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

import { testPrismaClient } from "@/lib/test-prisma";
import { auth } from "../auth";
import { platformAdminTransaction, storeScoped } from "../db";
import { isRlsRejection } from "../listing/cross-store-write";
import { listReviewInbox, readTranscript, type ReviewInbox } from "./ai-oversight";
import { labelConversationAction } from "./ai-oversight-actions";
import { withAiOnboardingSettings } from "./platform-settings-test-lock";

const hasDb = !!process.env.DATABASE_URL;
const suffix = randomUUID().slice(0, 8);
const DAY = "2001-04-03";
const IN_DAY = new Date("2001-04-03T12:00:00.000Z");
const LAST_MS = new Date("2001-04-03T23:59:59.999Z");
/** Over any cost threshold another test file sets (1 to 20 cents, see platform-settings-test-lock). */
const ALWAYS_COSTLY = 1_000_000;
/** 3 cents: over the 2-cent default, under 20 cents. */
const MIDDLING = 30_000;
const NEXT_DAY = new Date("2001-04-04T00:00:00.000Z");
const DAY_BEFORE = new Date("2001-04-02T10:00:00.000Z");
const DAY_MS = 86_400_000;

const of = (inbox: ReviewInbox, kind: "shopper" | "copilot" | "admin") => inbox.rows.filter((row) => row.kind === kind);

type FakeSession = Awaited<ReturnType<typeof auth.api.getSession>>;

function signInAs(userId: string, role?: "platform_admin"): void {
  vi.spyOn(auth.api, "getSession").mockResolvedValue({
    user: { id: userId, email: `${userId}@example.com`, role, twoFactorEnabled: true },
    session: { twoFactorVerified: true },
  } as unknown as FakeSession);
}

describe.skipIf(!hasDb)("AI oversight", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  const admin = `ai-admin-${suffix}`;
  const owner = `ai-owner-${suffix}`;
  let flaggedShopper = "";
  let plainShopper = "";
  let costlyCopilot = "";
  let shopperB = "";
  let middlingShopper = "";
  let middlingCopilot = "";
  const adminChats: string[] = [];
  let costlyAdmin = "";
  let recentShopper = "";
  let oldShopper = "";

  async function shopper(storeId: string, lastMessageAt: Date, messages: unknown[] = [{ id: "u", role: "user", parts: [{ type: "text", text: "hi" }] }]) {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    return (await storeScoped(storeId).aiConversation.create({
      data: { storeId, cartId: cart.id, model: "claude-haiku-5-5", messages: messages as never, createdAt: lastMessageAt, lastMessageAt },
    })).id;
  }

  async function copilot(storeId: string, lastMessageAt: Date, costMicros = 500) {
    return (await storeScoped(storeId).copilotConversation.create({
      data: {
        storeId,
        userId: owner,
        model: "claude-haiku-5-5",
        messages: [{ role: "owner", text: "sold 2 gari" }, { role: "assistant", text: "Done.", messageId: "m", costMicros }],
        createdAt: lastMessageAt,
        lastMessageAt,
      },
    })).id;
  }

  async function adminChat(lastMessageAt: Date, costMicros = 500, question = "Which stores are past due?") {
    return (await platformAdminTransaction((tx) => tx.adminAssistantConversation.create({
      data: {
        userId: admin,
        model: "claude-haiku-5-5",
        messages: [{ role: "admin", text: question }, { role: "assistant", text: "Two stores.", messageId: "m", costMicros }],
        createdAt: lastMessageAt,
        lastMessageAt,
      },
    }))).id;
  }

  async function action(storeId: string, conversationId: string, tool: string, ok: boolean, output: object, createdAt = IN_DAY) {
    await storeScoped(storeId).aiAction.create({ data: { storeId, conversationId, tool, input: {}, output, ok, createdAt } });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.user.create({ data: { id: admin, email: `${admin}@example.com`, name: "Admin", emailVerified: true, role: "platform_admin" } });
    await raw.user.create({ data: { id: owner, email: `${owner}@example.com`, name: "Owner", emailVerified: true } });
    storeA = (await raw.store.create({ data: { slug: `ai-ov-a-${suffix}`, name: "Oversight A", themePreset: "palm-and-shea" } })).id;
    storeB = (await raw.store.create({ data: { slug: `ai-ov-b-${suffix}`, name: "Oversight B", themePreset: "lagoon-and-coral" } })).id;

    // Store A: seven quiet shopper chats on the day, one flagged one whose last message was the next day.
    plainShopper = await shopper(storeA, LAST_MS, [
      { id: "u1", role: "user", parts: [{ type: "text", text: "egusi?" }, { type: "data-attachment", data: { name: "list.jpg", mediaType: "image/jpeg", bytes: 900, digest: "d" } }] },
      { id: "a1", role: "assistant", parts: [{ type: "tool-search_catalog", toolCallId: "c", state: "output-available", input: { query: "egusi" }, output: { ok: true, items: [] } }, { type: "text", text: "None today." }] },
    ]);
    for (let i = 0; i < 6; i += 1) await shopper(storeA, IN_DAY);
    flaggedShopper = await shopper(storeA, NEXT_DAY);
    await action(storeA, flaggedShopper, "grounding_strip", true, {});
    await action(storeA, flaggedShopper, "add_to_cart", true, { ok: true, items: [{ ok: false, code: "variant_not_found" }] });
    await action(storeA, flaggedShopper, "forward_to_store", true, { ok: true });
    await action(storeA, flaggedShopper, "turn_cost", true, { costMicros: ALWAYS_COSTLY });
    middlingShopper = await shopper(storeA, IN_DAY);
    await action(storeA, middlingShopper, "turn_cost", true, { costMicros: MIDDLING });
    // Outside the day: neither sampled nor flagged.
    const before = await shopper(storeA, DAY_BEFORE);
    await action(storeA, before, "grounding_strip", true, {}, DAY_BEFORE);

    for (let i = 0; i < 5; i += 1) await copilot(storeA, IN_DAY);
    costlyCopilot = await copilot(storeA, IN_DAY, ALWAYS_COSTLY);
    middlingCopilot = await copilot(storeA, IN_DAY, MIDDLING);

    shopperB = await shopper(storeB, LAST_MS);
    await shopper(storeB, NEXT_DAY);
    await action(storeB, shopperB, "add_to_cart", false, { ok: false, code: "cannot_confirm" });

    // Platform admin assistant chats belong to no store: the day's sample is taken across the platform.
    await platformAdminTransaction((tx) => tx.adminAssistantConversation.deleteMany({ where: { lastMessageAt: { gte: DAY_BEFORE, lt: NEXT_DAY } } }));
    for (let i = 0; i < 6; i += 1) adminChats.push(await adminChat(IN_DAY));
    costlyAdmin = await adminChat(IN_DAY, ALWAYS_COSTLY, "Refund order 1042?");

    // The default range is the last 7 UTC days, today included.
    recentShopper = await shopper(storeB, new Date(Date.now() - 2 * DAY_MS), [{ id: "u", role: "user", parts: [{ type: "text", text: "Do you have fresh ugu?" }] }]);
    oldShopper = await shopper(storeB, new Date(Date.now() - 8 * DAY_MS));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    const stores = [storeA, storeB].filter(Boolean);
    await platformAdminTransaction(async (tx) => {
      await tx.aiReviewFlag.deleteMany({ where: { storeId: { in: stores } } });
      await tx.auditLog.deleteMany({ where: { actorId: admin } });
      await tx.copilotConversation.deleteMany({ where: { storeId: { in: stores } } });
      await tx.adminAssistantConversation.deleteMany({ where: { userId: admin } });
    });
    for (const store of stores) await storeScoped(store).cart.deleteMany({});
    await raw.store.deleteMany({ where: { id: { in: stores } } });
    await raw.user.deleteMany({ where: { id: { in: [admin, owner] } } });
    await raw.$disconnect();
  });

  it("samples at most 5 shopper and 5 copilot chats per store for the UTC day by default, plus every auto-flagged one", async () => {
    signInAs(admin, "platform_admin");
    const sample = await withAiOnboardingSettings({ aiDailySamplePerStore: 5, aiTurnCostFlagCents: 2 }, () => listReviewInbox({ day: DAY, storeId: storeA }));

    const sampledShopper = of(sample, "shopper").filter((row) => row.sampled);
    expect(sampledShopper).toHaveLength(5);
    expect(of(sample, "shopper").every((row) => row.storeId === storeA)).toBe(true);
    const flagged = of(sample, "shopper").find((row) => row.id === flaggedShopper);
    expect(flagged?.reasons).toEqual(["amount_removed", "made_up_id", "forwarded", "costly_turn"]);
    expect(of(sample, "shopper").filter((row) => !row.sampled).every((row) => row.reasons.length > 0)).toBe(true);
    expect(of(sample, "shopper").some((row) => row.lastMessageAt < "2001-04-03")).toBe(false);

    expect(of(sample, "copilot").filter((row) => row.sampled)).toHaveLength(5);
    expect(of(sample, "copilot").find((row) => row.id === costlyCopilot)?.reasons).toEqual(["costly_turn"]);

    const again = await listReviewInbox({ day: DAY, storeId: storeA });
    expect(of(again, "shopper").map((row) => row.id)).toEqual(of(sample, "shopper").map((row) => row.id));
  });

  it("AC3 (#561): the daily sample size and the cost threshold are the platform settings, read on every list and view", async () => {
    signInAs(admin, "platform_admin");
    const reasonsOf = (rows: Array<{ id: string; reasons: string[] }>, id: string) => rows.find((row) => row.id === id)?.reasons ?? [];
    const turnCostReasons = async () => (await readTranscript({ kind: "shopper", id: middlingShopper }))?.actions.find((row) => row.tool === "turn_cost")?.reasons;

    await withAiOnboardingSettings({ aiDailySamplePerStore: 2, aiTurnCostFlagCents: 20 }, async () => {
      const sample = await listReviewInbox({ day: DAY, storeId: storeA });
      expect(sample.samplePerStore).toBe(2);
      expect(of(sample, "shopper").filter((row) => row.sampled)).toHaveLength(2);
      expect(of(sample, "copilot").filter((row) => row.sampled)).toHaveLength(2);
      expect(reasonsOf(of(sample, "shopper"), middlingShopper)).toEqual([]);
      expect(reasonsOf(of(sample, "copilot"), middlingCopilot)).toEqual([]);
      expect(reasonsOf(of(sample, "copilot"), costlyCopilot)).toEqual(["costly_turn"]);
      expect(await turnCostReasons()).toEqual([]);
    });

    await withAiOnboardingSettings({ aiDailySamplePerStore: 0, aiTurnCostFlagCents: 2 }, async () => {
      const sample = await listReviewInbox({ day: DAY, storeId: storeA });
      expect(of(sample, "shopper").some((row) => row.sampled)).toBe(false);
      expect(of(sample, "shopper").every((row) => row.reasons.length > 0)).toBe(true);
      expect(reasonsOf(of(sample, "shopper"), middlingShopper)).toEqual(["costly_turn"]);
      expect(of(sample, "copilot").map((row) => row.id).sort()).toEqual([costlyCopilot, middlingCopilot].sort());
      expect(await turnCostReasons()).toEqual(["costly_turn"]);
    });
  });

  it("counts the last millisecond as the day, not the next midnight, and keeps each store's rows apart", async () => {
    signInAs(admin, "platform_admin");
    const all = await listReviewInbox({ day: DAY });
    const ids = new Set(of(all, "shopper").map((row) => row.id));
    expect(ids.has(shopperB)).toBe(true);
    const rowB = of(all, "shopper").find((row) => row.id === shopperB);
    expect(rowB).toMatchObject({ storeId: storeB, storeName: "Oversight B", reasons: ["needs_refusal"] });

    const onlyB = await listReviewInbox({ day: DAY, storeId: storeB });
    expect(of(onlyB, "shopper").map((row) => row.id)).toEqual([shopperB]);
    expect(of(onlyB, "copilot")).toEqual([]);
    expect(of(onlyB, "admin")).toEqual([]);
  });

  it("samples platform admin assistant chats per UTC day under the same settings, with the costly ones flagged", async () => {
    signInAs(admin, "platform_admin");
    const sample = await withAiOnboardingSettings({ aiDailySamplePerStore: 5, aiTurnCostFlagCents: 2 }, () => listReviewInbox({ day: DAY, kind: "admin" }));
    const rows = of(sample, "admin");
    expect(sample.rows).toEqual(rows);
    expect(rows.filter((row) => row.sampled)).toHaveLength(5);
    expect(rows.find((row) => row.id === costlyAdmin)).toMatchObject({ reasons: ["costly_turn"], storeId: null, storeName: null });
    expect(rows[0]?.id).toBe(costlyAdmin);
    expect(rows[0]?.firstQuestion).toBe("Refund order 1042?");

    const none = await withAiOnboardingSettings({ aiDailySamplePerStore: 0, aiTurnCostFlagCents: 2 }, () => listReviewInbox({ day: DAY, kind: "admin" }));
    expect(none.rows.map((row) => row.id)).toEqual([costlyAdmin]);
  });

  it("shows the last 7 UTC days by default, flagged first then newest, with the first question and counts per filter", async () => {
    signInAs(admin, "platform_admin");
    const inbox = await withAiOnboardingSettings({ aiDailySamplePerStore: 5, aiTurnCostFlagCents: 2 }, () => listReviewInbox({ storeId: storeB }));
    expect(inbox.day).toBeNull();
    expect(inbox.to).toBe(new Date().toISOString().slice(0, 10));
    expect(Date.parse(inbox.to) - Date.parse(inbox.from)).toBe(6 * DAY_MS);
    const ids = inbox.rows.map((row) => row.id);
    expect(ids).toContain(recentShopper);
    expect(ids).not.toContain(oldShopper);
    expect(ids).not.toContain(shopperB);
    expect(inbox.rows.find((row) => row.id === recentShopper)?.firstQuestion).toBe("Do you have fresh ugu?");

    const day = await listReviewInbox({ day: DAY });
    const quietAt = day.rows.findIndex((row) => row.reasons.length === 0);
    expect(quietAt).toBeGreaterThan(0);
    expect(day.rows.slice(quietAt).every((row) => row.reasons.length === 0)).toBe(true);
    expect(day.rows.slice(quietAt).map((row) => row.lastMessageAt)).toEqual(day.rows.slice(quietAt).map((row) => row.lastMessageAt).sort().reverse());
    expect(day.counts.kind.admin).toBe(of(day, "admin").length);
    expect(day.counts.store[storeB]).toBe(day.rows.filter((row) => row.storeId === storeB).length);

    const flaggedOnly = await listReviewInbox({ day: DAY, flagged: true, kind: "shopper" });
    expect(flaggedOnly.rows.length).toBeGreaterThan(0);
    expect(flaggedOnly.rows.every((row) => row.kind === "shopper" && row.reasons.length > 0)).toBe(true);
    expect(flaggedOnly.total).toBe(day.total);
  });

  it("shows a transcript's scrubbed messages and tool calls, never file content, and audits every view", async () => {
    signInAs(admin, "platform_admin");
    const transcript = await readTranscript({ kind: "shopper", id: plainShopper });
    expect(transcript?.storeName).toBe("Oversight A");
    expect(transcript?.messages[0]?.parts).toContainEqual({ kind: "attachment", name: "list.jpg", mediaType: "image/jpeg", bytes: 900, pages: null });
    expect(transcript?.messages[1]?.parts[0]).toMatchObject({ kind: "tool", tool: "search_catalog" });
    expect(JSON.stringify(transcript)).not.toContain("digest");

    const flagged = await readTranscript({ kind: "shopper", id: flaggedShopper });
    expect(flagged?.actions.map((row) => [row.tool, row.reasons])).toEqual([
      ["grounding_strip", ["amount_removed"]],
      ["add_to_cart", ["made_up_id"]],
      ["forward_to_store", ["forwarded"]],
      ["turn_cost", ["costly_turn"]],
    ]);
    await readTranscript({ kind: "copilot", id: costlyCopilot });
    const adminTranscript = await readTranscript({ kind: "admin", id: costlyAdmin });
    expect(adminTranscript).toMatchObject({ storeId: null, storeName: null, askedBy: `${admin}@example.com` });
    expect(adminTranscript?.messages.map((message) => message.role)).toEqual(["admin", "assistant"]);

    const audits = await platformAdminTransaction((tx) => tx.auditLog.findMany({
      where: { actorId: admin, action: "ai_conversation.view" },
      orderBy: { createdAt: "asc" },
    }));
    expect(audits.map((row) => [row.storeId, row.entityType, row.entityId])).toEqual(expect.arrayContaining([
      [storeA, "ai_conversation", plainShopper],
      [storeA, "ai_conversation", flaggedShopper],
      [storeA, "copilot_conversation", costlyCopilot],
      [null, "admin_assistant_conversation", costlyAdmin],
    ]));
    expect(await readTranscript({ kind: "shopper", id: `missing-${suffix}` })).toBeNull();
  });

  it("refuses everyone but a platform admin", async () => {
    signInAs(owner);
    await expect(listReviewInbox({ day: DAY })).rejects.toThrow("REDIRECT:/admin/sign-in");
    await expect(readTranscript({ kind: "shopper", id: plainShopper })).rejects.toThrow("REDIRECT:/admin/sign-in");
    await expect(labelConversationAction({ kind: "shopper", conversationId: plainShopper, label: "tone", note: "" }))
      .rejects.toThrow("REDIRECT:/admin/sign-in");
  });

  it("labels a conversation on its own store with a note and an audit row, and refuses unknown labels", async () => {
    signInAs(admin, "platform_admin");
    expect(await labelConversationAction({ kind: "shopper", conversationId: shopperB, label: "wrong_price", note: "Said $3" })).toEqual({ ok: true });
    expect(await labelConversationAction({ kind: "copilot", conversationId: costlyCopilot, label: "other", note: "" })).toEqual({ ok: true });
    expect(await labelConversationAction({ kind: "shopper", conversationId: shopperB, label: "rude", note: "" })).toMatchObject({ ok: false });
    expect(await labelConversationAction({ kind: "shopper", conversationId: shopperB, label: "tone", note: "x".repeat(1001) })).toMatchObject({ ok: false });
    expect(await labelConversationAction({ kind: "copilot", conversationId: shopperB, label: "tone", note: "" })).toMatchObject({ ok: false });

    const flags = await platformAdminTransaction((tx) => tx.aiReviewFlag.findMany({ where: { storeId: { in: [storeA, storeB] } } }));
    expect(flags.map((flag) => [flag.storeId, flag.aiConversationId, flag.copilotConversationId, flag.label, flag.note, flag.createdById])).toEqual(
      expect.arrayContaining([
        [storeB, shopperB, null, "wrong_price", "Said $3", admin],
        [storeA, null, costlyCopilot, "other", "", admin],
      ]),
    );
    expect(flags).toHaveLength(2);
    const audit = await platformAdminTransaction((tx) => tx.auditLog.findFirst({ where: { actorId: admin, action: "ai_conversation.label", entityId: shopperB } }));
    expect(audit).toMatchObject({ storeId: storeB, after: { label: "wrong_price" } });

    const transcript = await readTranscript({ kind: "shopper", id: shopperB });
    expect(transcript?.flags.map((flag) => [flag.label, flag.note])).toEqual([["wrong_price", "Said $3"]]);
    const sample = await listReviewInbox({ day: DAY, storeId: storeB });
    expect(of(sample, "shopper")[0]?.labels).toEqual(["wrong_price"]);

    expect(await labelConversationAction({ kind: "admin", conversationId: costlyAdmin, label: "wrong_item", note: "Named the wrong order" })).toEqual({ ok: true });
    const adminFlag = await platformAdminTransaction((tx) => tx.aiReviewFlag.findFirst({ where: { adminAssistantConversationId: costlyAdmin } }));
    expect(adminFlag).toMatchObject({ storeId: null, label: "wrong_item", note: "Named the wrong order", createdById: admin });
    const adminAudit = await platformAdminTransaction((tx) => tx.auditLog.findFirst({ where: { actorId: admin, action: "ai_conversation.label", entityId: costlyAdmin } }));
    expect(adminAudit).toMatchObject({ storeId: null, entityType: "admin_assistant_conversation", after: { label: "wrong_item" } });
    const adminRows = of(await listReviewInbox({ day: DAY, kind: "admin" }), "admin");
    expect(adminRows.find((row) => row.id === costlyAdmin)?.labels).toEqual(["wrong_item"]);
  });

  it("keeps each store's flags behind row-level security", async () => {
    signInAs(admin, "platform_admin");
    await labelConversationAction({ kind: "shopper", conversationId: flaggedShopper, label: "unsafe", note: "A only" });

    const seenByB = await storeScoped(storeB).aiReviewFlag.findMany({});
    expect(seenByB.every((flag) => flag.storeId === storeB)).toBe(true);
    expect(seenByB.some((flag) => flag.aiConversationId === flaggedShopper)).toBe(false);
    expect((await storeScoped(storeA).aiReviewFlag.findMany({})).some((flag) => flag.note === "A only")).toBe(true);
    // A platform admin assistant chat's flag has no store, so no store session sees it.
    await labelConversationAction({ kind: "admin", conversationId: adminChats[0], label: "tone", note: "admin only" });
    expect((await storeScoped(storeA).aiReviewFlag.findMany({})).some((flag) => flag.note === "admin only")).toBe(false);

    const error = await storeScoped(storeB).aiReviewFlag.create({
      data: { storeId: storeA, aiConversationId: flaggedShopper, label: "tone", createdById: owner },
    }).then(() => null, (caught: unknown) => caught);
    expect(isRlsRejection(error)).toBe(true);
    // A flag cannot point at another store's conversation, even as platform admin.
    const crossed = await platformAdminTransaction((tx) => tx.aiReviewFlag.create({
      data: { storeId: storeB, aiConversationId: flaggedShopper, label: "tone", createdById: admin },
    })).then(() => null, (caught: unknown) => caught);
    expect(String(crossed)).toMatch(/foreign key|ai_review_flags_ai_conversation_id_store_id_fkey/i);
  });
});
