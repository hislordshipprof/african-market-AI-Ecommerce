import { z } from "zod";
import { Prisma, platformAdminTransaction, txQuery } from "../db";
import { parseInput } from "../security/parse-input";
import { readAiOnboardingSettings, turnCostFlagMicros } from "./ai-onboarding-settings";
import { requirePlatformAdmin } from "./session";
import {
  actionFlagReasons,
  copilotTranscript,
  FLAG_REASONS,
  shopperTranscript,
  type FlagReason,
  type ReviewLabel,
  type TranscriptMessage,
} from "./ai-review";

/** Rows shown per kind; a store filter narrows the rest. */
export const LIST_CAP = 300;

export type ConversationKind = "shopper" | "copilot";

export interface SampleRow {
  kind: ConversationKind;
  id: string;
  storeId: string;
  storeName: string;
  lastMessageAt: string;
  messageCount: number;
  sampled: boolean;
  reasons: FlagReason[];
  labels: ReviewLabel[];
}

export interface ConversationSample {
  day: string;
  storeId: string | null;
  shopper: SampleRow[];
  copilot: SampleRow[];
  hidden: { shopper: number; copilot: number };
  /** Random chats per store per kind, from the platform setting (#561). */
  samplePerStore: number;
  /** Every store, for the store filter. */
  stores: Array<{ id: string; name: string }>;
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const sampleInput = z.object({
  day: z.string().regex(dayPattern).refine((day) => new Date(`${day}T00:00:00.000Z`).toISOString().startsWith(day)).optional(),
  storeId: z.string().min(1).max(200).optional(),
});

/** Today's date in UTC, YYYY-MM-DD. */
export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

interface DbRow {
  id: string;
  storeId: string;
  storeName: string;
  lastMessageAt: Date;
  messageCount: number;
}

function toRow(kind: ConversationKind, row: DbRow, sampled: boolean, reasons: FlagReason[]): SampleRow {
  return {
    kind,
    id: row.id,
    storeId: row.storeId,
    storeName: row.storeName,
    lastMessageAt: row.lastMessageAt.toISOString(),
    messageCount: Number(row.messageCount),
    sampled,
    reasons,
    labels: [],
  };
}

/** Store name, then flagged before quiet, then newest first. */
function ordered(rows: SampleRow[]): SampleRow[] {
  return rows.sort((a, b) =>
    a.storeName.localeCompare(b.storeName)
    || a.storeId.localeCompare(b.storeId)
    || Number(b.reasons.length > 0) - Number(a.reasons.length > 0)
    || b.lastMessageAt.localeCompare(a.lastMessageAt)
    || a.id.localeCompare(b.id));
}

/**
 * The day's review list: up to N random shopper and N random copilot chats per store whose last message falls on the
 * UTC day, plus every shopper chat with an auto-flagged action that day and every copilot chat on the day with a
 * turn over the cost threshold. N and the threshold are platform settings (#561), read on each call. The order inside
 * a store is md5(id || day), so a reload shows the same sample.
 */
export async function listConversationSample(input: { day?: string; storeId?: string }): Promise<ConversationSample> {
  await requirePlatformAdmin();
  const parsed = parseInput(sampleInput, input);
  const day = parsed.ok && parsed.data.day ? parsed.data.day : todayUtc();
  const storeId = parsed.ok ? parsed.data.storeId ?? null : null;
  // Naive UTC bounds against timestamp(3) columns, as the retention job does.
  const lo = `${day} 00:00:00`;
  const hi = `${nextDay(day)} 00:00:00`;

  return platformAdminTransaction(async (tx) => {
    const settings = await readAiOnboardingSettings(tx);
    const samplePerStore = settings.dailySamplePerStore;
    const costFlagMicros = turnCostFlagMicros(settings);
    const inStore = (column: Prisma.Sql) => (storeId ? Prisma.sql`AND ${column} = ${storeId}` : Prisma.empty);

    const sampledIds = await txQuery<Array<{ id: string }>>(tx, Prisma.sql`
      SELECT id FROM (
        SELECT c.id, row_number() OVER (PARTITION BY c.store_id ORDER BY md5(c.id || ${day}), c.id) AS rn
        FROM ai_conversations c
        WHERE c.last_message_at >= ${lo}::timestamp AND c.last_message_at < ${hi}::timestamp
          AND jsonb_typeof(c.messages) = 'array' AND jsonb_array_length(c.messages) > 0
          ${inStore(Prisma.sql`c.store_id`)}
      ) ranked
      WHERE rn <= ${samplePerStore}
    `);
    // A broad prefilter; actionFlagReasons decides.
    const candidates = await txQuery<Array<{ conversationId: string; tool: string; ok: boolean; output: unknown }>>(tx, Prisma.sql`
      SELECT a.conversation_id AS "conversationId", a.tool, a.ok, a.output
      FROM ai_actions a
      WHERE a.created_at >= ${lo}::timestamp AND a.created_at < ${hi}::timestamp
        ${inStore(Prisma.sql`a.store_id`)}
        AND (
          a.tool IN ('grounding_strip', 'forward_to_store')
          OR NOT a.ok
          OR a.output -> 'notFound' IS NOT NULL
          OR a.output -> 'excluded' IS NOT NULL
          OR (a.tool = 'add_to_cart' AND a.output -> 'items' IS NOT NULL)
          OR (a.tool = 'turn_cost' AND jsonb_typeof(a.output -> 'costMicros') = 'number'
              AND (a.output ->> 'costMicros')::numeric > ${costFlagMicros})
        )
    `);
    const reasonsOf = new Map<string, Set<FlagReason>>();
    for (const action of candidates) {
      const reasons = actionFlagReasons(action, costFlagMicros);
      if (reasons.length === 0) continue;
      const set = reasonsOf.get(action.conversationId) ?? new Set<FlagReason>();
      for (const reason of reasons) set.add(reason);
      reasonsOf.set(action.conversationId, set);
    }
    const sampled = new Set(sampledIds.map((row) => row.id));
    const shopperIds = [...new Set([...sampled, ...reasonsOf.keys()])];
    const shopperRows = shopperIds.length === 0 ? [] : await txQuery<DbRow[]>(tx, Prisma.sql`
      SELECT c.id, c.store_id AS "storeId", s.name AS "storeName", c.last_message_at AS "lastMessageAt",
             jsonb_array_length(c.messages)::int AS "messageCount"
      FROM ai_conversations c JOIN stores s ON s.id = c.store_id
      WHERE c.id IN (${Prisma.join(shopperIds)})
    `);
    const shopper = ordered(shopperRows.map((row) => {
      const reasons = reasonsOf.get(row.id);
      return toRow("shopper", row, sampled.has(row.id), reasons ? FLAG_REASONS.filter((reason) => reasons.has(reason)) : []);
    }));

    const copilotRows = await txQuery<Array<DbRow & { sampled: boolean; costly: boolean }>>(tx, Prisma.sql`
      SELECT ranked.id, ranked.store_id AS "storeId", s.name AS "storeName", ranked.last_message_at AS "lastMessageAt",
             ranked.message_count AS "messageCount", ranked.rn <= ${samplePerStore} AS sampled, ranked.costly
      FROM (
        SELECT c.id, c.store_id, c.last_message_at, jsonb_array_length(c.messages)::int AS message_count,
               row_number() OVER (PARTITION BY c.store_id ORDER BY md5(c.id || ${day}), c.id) AS rn,
               jsonb_path_exists(c.messages, '$[*] ? (@.costMicros > $t)', jsonb_build_object('t', ${costFlagMicros}::int)) AS costly
        FROM copilot_conversations c
        WHERE c.last_message_at >= ${lo}::timestamp AND c.last_message_at < ${hi}::timestamp
          AND jsonb_typeof(c.messages) = 'array' AND jsonb_array_length(c.messages) > 0
          ${inStore(Prisma.sql`c.store_id`)}
      ) ranked JOIN stores s ON s.id = ranked.store_id
      WHERE ranked.rn <= ${samplePerStore} OR ranked.costly
    `);
    const copilot = ordered(copilotRows.map((row) => toRow("copilot", row, row.sampled, row.costly ? ["costly_turn"] : [])));

    const shown = { shopper: shopper.slice(0, LIST_CAP), copilot: copilot.slice(0, LIST_CAP) };
    const flags = await tx.aiReviewFlag.findMany({
      where: {
        OR: [
          { aiConversationId: { in: shown.shopper.map((row) => row.id) } },
          { copilotConversationId: { in: shown.copilot.map((row) => row.id) } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { label: true, aiConversationId: true, copilotConversationId: true },
    });
    const labelsOf = new Map<string, ReviewLabel[]>();
    for (const flag of flags) {
      const id = flag.aiConversationId ?? flag.copilotConversationId;
      if (!id) continue;
      labelsOf.set(id, [...(labelsOf.get(id) ?? []), flag.label as ReviewLabel]);
    }
    for (const row of [...shown.shopper, ...shown.copilot]) row.labels = labelsOf.get(row.id) ?? [];

    const stores = await tx.store.findMany({ select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
    return {
      day,
      storeId,
      stores,
      samplePerStore,
      ...shown,
      hidden: { shopper: shopper.length - shown.shopper.length, copilot: copilot.length - shown.copilot.length },
    };
  });
}

export interface TranscriptAction {
  id: string;
  tool: string;
  ok: boolean;
  input: unknown;
  output: unknown;
  createdAt: string;
  reasons: FlagReason[];
}

export interface TranscriptProposal {
  id: string;
  listingName: string;
  kind: string;
  quantity: number | null;
  statusValue: string | null;
  state: string;
  createdAt: string;
}

export interface TranscriptFlag {
  id: string;
  label: ReviewLabel;
  note: string;
  createdAt: string;
  createdByEmail: string;
}

export interface Transcript {
  kind: ConversationKind;
  id: string;
  storeId: string;
  storeName: string;
  storeTimezone: string;
  model: string;
  costMicros: number;
  createdAt: string;
  lastMessageAt: string;
  messages: TranscriptMessage[];
  actions: TranscriptAction[];
  proposals: TranscriptProposal[];
  flags: TranscriptFlag[];
}

const transcriptInput = z.strictObject({
  kind: z.enum(["shopper", "copilot"]),
  id: z.string().min(1).max(200),
});

const FLAG_SELECT = {
  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  select: { id: true, label: true, note: true, createdAt: true, createdBy: { select: { email: true } } },
} satisfies Prisma.AiConversation$flagsArgs;

function flagRows(rows: Array<{ id: string; label: string; note: string; createdAt: Date; createdBy: { email: string } }>): TranscriptFlag[] {
  return rows.map((row) => ({
    id: row.id,
    label: row.label as ReviewLabel,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    createdByEmail: row.createdBy.email,
  }));
}

/**
 * One stored, scrubbed transcript and its tool calls. Every view writes an audit row in the same
 * transaction, so a transcript is never shown without one. Unknown or malformed ids return null.
 */
export async function readTranscript(input: { kind: ConversationKind; id: string }): Promise<Transcript | null> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(transcriptInput, input);
  if (!parsed.ok) return null;
  const { kind, id } = parsed.data;

  return platformAdminTransaction(async (tx) => {
    const costFlagMicros = turnCostFlagMicros(await readAiOnboardingSettings(tx));
    const audit = (storeId: string, entityType: string) => tx.auditLog.create({
      data: {
        storeId,
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "ai_conversation.view",
        entityType,
        entityId: id,
      },
    });

    if (kind === "shopper") {
      const row = await tx.aiConversation.findUnique({
        where: { id },
        select: {
          id: true,
          storeId: true,
          model: true,
          costMicros: true,
          createdAt: true,
          lastMessageAt: true,
          messages: true,
          store: { select: { name: true, timezone: true } },
          actions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, tool: true, ok: true, input: true, output: true, createdAt: true } },
          flags: FLAG_SELECT,
        },
      });
      if (!row) return null;
      await audit(row.storeId, "ai_conversation");
      return {
        kind,
        id: row.id,
        storeId: row.storeId,
        storeName: row.store.name,
        storeTimezone: row.store.timezone,
        model: row.model,
        costMicros: Number(row.costMicros),
        createdAt: row.createdAt.toISOString(),
        lastMessageAt: row.lastMessageAt.toISOString(),
        messages: shopperTranscript(row.messages),
        actions: row.actions.map((action) => ({
          id: action.id,
          tool: action.tool,
          ok: action.ok,
          input: action.input,
          output: action.output,
          createdAt: action.createdAt.toISOString(),
          reasons: actionFlagReasons(action, costFlagMicros),
        })),
        proposals: [],
        flags: flagRows(row.flags),
      };
    }

    const row = await tx.copilotConversation.findUnique({
      where: { id },
      select: {
        id: true,
        storeId: true,
        model: true,
        costMicros: true,
        createdAt: true,
        lastMessageAt: true,
        messages: true,
        store: { select: { name: true, timezone: true } },
        proposals: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, listingId: true, kind: true, quantity: true, statusValue: true, state: true, createdAt: true },
        },
        flags: FLAG_SELECT,
      },
    });
    if (!row) return null;
    await audit(row.storeId, "copilot_conversation");
    const listingIds = [...new Set(row.proposals.map((proposal) => proposal.listingId))];
    const names = listingIds.length === 0 ? [] : await txQuery<Array<{ id: string; name: string }>>(tx, Prisma.sql`
      SELECT l.id, COALESCE(l.custom_name, mp.name, 'Unnamed listing') AS name
      FROM listings l LEFT JOIN master_products mp ON mp.id = l.master_product_id
      WHERE l.store_id = ${row.storeId} AND l.id IN (${Prisma.join(listingIds)})
    `);
    const nameOf = new Map(names.map((entry) => [entry.id, entry.name]));
    return {
      kind,
      id: row.id,
      storeId: row.storeId,
      storeName: row.store.name,
      storeTimezone: row.store.timezone,
      model: row.model,
      costMicros: Number(row.costMicros),
      createdAt: row.createdAt.toISOString(),
      lastMessageAt: row.lastMessageAt.toISOString(),
      messages: copilotTranscript(row.messages),
      actions: [],
      proposals: row.proposals.map((proposal) => ({
        id: proposal.id,
        listingName: nameOf.get(proposal.listingId) ?? "Listing no longer in the store",
        kind: proposal.kind,
        quantity: proposal.quantity,
        statusValue: proposal.statusValue,
        state: proposal.state,
        createdAt: proposal.createdAt.toISOString(),
      })),
      flags: flagRows(row.flags),
    };
  });
}
