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
import { TURN_COST_FLAG_MICROS } from "./ai-review";
import { listConversationSample, readTranscript } from "./ai-oversight";
import { labelConversationAction } from "./ai-oversight-actions";

const hasDb = !!process.env.DATABASE_URL;
const suffix = randomUUID().slice(0, 8);
const DAY = "2001-02-03";
const IN_DAY = new Date("2001-02-03T12:00:00.000Z");
const LAST_MS = new Date("2001-02-03T23:59:59.999Z");
const NEXT_DAY = new Date("2001-02-04T00:00:00.000Z");
const DAY_BEFORE = new Date("2001-02-02T10:00:00.000Z");

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
    await action(storeA, flaggedShopper, "turn_cost", true, { costMicros: TURN_COST_FLAG_MICROS + 1 });
    // Outside the day: neither sampled nor flagged.
    const before = await shopper(storeA, DAY_BEFORE);
    await action(storeA, before, "grounding_strip", true, {}, DAY_BEFORE);

    for (let i = 0; i < 5; i += 1) await copilot(storeA, IN_DAY);
    costlyCopilot = await copilot(storeA, IN_DAY, TURN_COST_FLAG_MICROS + 1);

    shopperB = await shopper(storeB, LAST_MS);
    await shopper(storeB, NEXT_DAY);
    await action(storeB, shopperB, "add_to_cart", false, { ok: false, code: "cannot_confirm" });
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
    });
    for (const store of stores) await storeScoped(store).cart.deleteMany({});
    await raw.store.deleteMany({ where: { id: { in: stores } } });
    await raw.user.deleteMany({ where: { id: { in: [admin, owner] } } });
    await raw.$disconnect();
  });

  it("samples at most 5 shopper and 5 copilot chats per store for the UTC day, plus every auto-flagged one", async () => {
    signInAs(admin, "platform_admin");
    const sample = await listConversationSample({ day: DAY, storeId: storeA });

    const sampledShopper = sample.shopper.filter((row) => row.sampled);
    expect(sampledShopper).toHaveLength(5);
    expect(sample.shopper.every((row) => row.storeId === storeA)).toBe(true);
    const flagged = sample.shopper.find((row) => row.id === flaggedShopper);
    expect(flagged?.reasons).toEqual(["amount_removed", "made_up_id", "forwarded", "costly_turn"]);
    expect(sample.shopper.filter((row) => !row.sampled).every((row) => row.reasons.length > 0)).toBe(true);
    expect(sample.shopper.some((row) => row.lastMessageAt < "2001-02-03")).toBe(false);

    expect(sample.copilot.filter((row) => row.sampled)).toHaveLength(5);
    expect(sample.copilot.find((row) => row.id === costlyCopilot)?.reasons).toEqual(["costly_turn"]);

    const again = await listConversationSample({ day: DAY, storeId: storeA });
    expect(again.shopper.map((row) => row.id)).toEqual(sample.shopper.map((row) => row.id));
  });

  it("counts the last millisecond as the day, not the next midnight, and keeps each store's rows apart", async () => {
    signInAs(admin, "platform_admin");
    const all = await listConversationSample({ day: DAY });
    const ids = new Set(all.shopper.map((row) => row.id));
    expect(ids.has(shopperB)).toBe(true);
    const rowB = all.shopper.find((row) => row.id === shopperB);
    expect(rowB).toMatchObject({ storeId: storeB, storeName: "Oversight B", reasons: ["needs_refusal"] });

    const onlyB = await listConversationSample({ day: DAY, storeId: storeB });
    expect(onlyB.shopper.map((row) => row.id)).toEqual([shopperB]);
    expect(onlyB.copilot).toEqual([]);
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

    const audits = await platformAdminTransaction((tx) => tx.auditLog.findMany({
      where: { actorId: admin, action: "ai_conversation.view" },
      orderBy: { createdAt: "asc" },
    }));
    expect(audits.map((row) => [row.storeId, row.entityType, row.entityId])).toEqual(expect.arrayContaining([
      [storeA, "ai_conversation", plainShopper],
      [storeA, "ai_conversation", flaggedShopper],
      [storeA, "copilot_conversation", costlyCopilot],
    ]));
    expect(await readTranscript({ kind: "shopper", id: `missing-${suffix}` })).toBeNull();
  });

  it("refuses everyone but a platform admin", async () => {
    signInAs(owner);
    await expect(listConversationSample({ day: DAY })).rejects.toThrow("REDIRECT:/admin/sign-in");
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
    const sample = await listConversationSample({ day: DAY, storeId: storeB });
    expect(sample.shopper[0]?.labels).toEqual(["wrong_price"]);
  });

  it("keeps each store's flags behind row-level security", async () => {
    signInAs(admin, "platform_admin");
    await labelConversationAction({ kind: "shopper", conversationId: flaggedShopper, label: "unsafe", note: "A only" });

    const seenByB = await storeScoped(storeB).aiReviewFlag.findMany({});
    expect(seenByB.every((flag) => flag.storeId === storeB)).toBe(true);
    expect(seenByB.some((flag) => flag.aiConversationId === flaggedShopper)).toBe(false);
    expect((await storeScoped(storeA).aiReviewFlag.findMany({})).some((flag) => flag.note === "A only")).toBe(true);

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
