import { z } from "zod";
import { Prisma, platformAdminTransaction, txQuery } from "../db";
import { parseInput } from "../security/parse-input";
import { readAiOnboardingSettings, turnCostFlagMicros } from "./ai-onboarding-settings";
import { requirePlatformAdmin } from "./session";
import {
  actionFlagReasons,
  chatKey,
  CONVERSATION_KINDS,
  copilotTranscript,
  filterInbox,
  FLAG_REASONS,
  inboxCounts,
  orderInbox,
  shopperTranscript,
  type ConversationKind,
  type FlagReason,
  type InboxFilters,
  type InboxRow,
  type ReviewLabel,
  type TranscriptMessage,
} from "./ai-review";

/** Rows shown at once; the filters narrow the rest. */
export const LIST_CAP = 300;

export type { ConversationKind, InboxRow } from "./ai-review";

export interface ReviewInbox {
  /** The single UTC day picked, or null for the default last 7 days. */
  day: string | null;
  /** First and last UTC day shown, inclusive. */
  from: string;
  to: string;
  filters: InboxFilters;
  /** The filtered list, flagged first then newest, at most LIST_CAP rows. */
  rows: InboxRow[];
  hidden: number;
  /** Every chat to review in the range, before the filters. */
  total: number;
  counts: ReturnType<typeof inboxCounts>;
  /** Random chats per store (and per day for the platform admin assistant), from the platform setting (#561). */
  samplePerStore: number;
  /** Every store, for the store filter. */
  stores: Array<{ id: string; name: string }>;
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const inboxInput = z.object({
  day: z.string().regex(dayPattern).refine((day) => new Date(`${day}T00:00:00.000Z`).toISOString().startsWith(day)).optional(),
  kind: z.enum(CONVERSATION_KINDS).optional(),
  storeId: z.string().min(1).max(200).optional(),
  flagged: z.boolean().optional(),
  unlabelled: z.boolean().optional(),
});

/** The default range: the last 7 UTC days, today included. */
export const RANGE_DAYS = 7;

/** Today's date in UTC, YYYY-MM-DD. */
export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function shiftDay(day: string, by: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + by * 86_400_000).toISOString().slice(0, 10);
}

interface DbRow {
  id: string;
  storeId: string | null;
  storeName: string | null;
  lastMessageAt: Date;
  messageCount: number;
  firstQuestion: string | null;
}

function toRow(kind: ConversationKind, row: DbRow, sampled: boolean, reasons: FlagReason[]): InboxRow {
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
    firstQuestion: row.firstQuestion ?? "",
  };
}

/** The first { role, text } turn from the asker, for copilot and platform admin assistant chats. */
const firstTextTurn = (asker: string) => Prisma.sql`(
  SELECT left(m.msg ->> 'text', 200) FROM jsonb_array_elements(c.messages) WITH ORDINALITY m(msg, i)
  WHERE m.msg ->> 'role' = ${asker} AND coalesce(m.msg ->> 'text', '') <> '' ORDER BY m.i LIMIT 1
)`;

/** A chat's UTC day, the key its sample is drawn under. */
const chatDay = Prisma.sql`to_char(c.last_message_at, 'YYYY-MM-DD')`;

/**
 * The review inbox (#856): for each UTC day in the range, up to N random shopper and N random copilot chats per store
 * whose last message falls on that day, and N random platform admin assistant chats, plus every shopper chat with an
 * auto-flagged action in the range and every copilot or platform admin chat with a turn over the cost threshold. N and
 * the threshold are platform settings (#561), read on each call. The order inside a store and day is
 * md5(id || day), so a reload shows the same sample. The range is one picked UTC day, or the last 7.
 */
export async function listReviewInbox(input: {
  day?: string;
  kind?: ConversationKind;
  storeId?: string;
  flagged?: boolean;
  unlabelled?: boolean;
}): Promise<ReviewInbox> {
  await requirePlatformAdmin();
  const parsed = parseInput(inboxInput, input);
  const data = parsed.ok ? parsed.data : {};
  const day = data.day ?? null;
  const to = day ?? todayUtc();
  const from = day ?? shiftDay(to, 1 - RANGE_DAYS);
  const filters: InboxFilters = {
    kind: data.kind ?? null,
    storeId: data.storeId ?? null,
    flagged: data.flagged ?? false,
    unlabelled: data.unlabelled ?? false,
  };
  // Naive UTC bounds against timestamp(3) columns, as the retention job does.
  const lo = `${from} 00:00:00`;
  const hi = `${shiftDay(to, 1)} 00:00:00`;
  const inRange = Prisma.sql`c.last_message_at >= ${lo}::timestamp AND c.last_message_at < ${hi}::timestamp
    AND jsonb_typeof(c.messages) = 'array' AND jsonb_array_length(c.messages) > 0`;

  return platformAdminTransaction(async (tx) => {
    const settings = await readAiOnboardingSettings(tx);
    const samplePerStore = settings.dailySamplePerStore;
    const costFlagMicros = turnCostFlagMicros(settings);

    const sampledIds = await txQuery<Array<{ id: string }>>(tx, Prisma.sql`
      SELECT id FROM (
        SELECT c.id, row_number() OVER (PARTITION BY c.store_id, ${chatDay} ORDER BY md5(c.id || ${chatDay}), c.id) AS rn
        FROM ai_conversations c
        WHERE ${inRange}
      ) ranked
      WHERE rn <= ${samplePerStore}
    `);
    // A broad prefilter; actionFlagReasons decides.
    const candidates = await txQuery<Array<{ conversationId: string; tool: string; ok: boolean; output: unknown }>>(tx, Prisma.sql`
      SELECT a.conversation_id AS "conversationId", a.tool, a.ok, a.output
      FROM ai_actions a
      WHERE a.created_at >= ${lo}::timestamp AND a.created_at < ${hi}::timestamp
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
             jsonb_array_length(c.messages)::int AS "messageCount",
             (
               SELECT left(p.part ->> 'text', 200)
               FROM jsonb_array_elements(c.messages) WITH ORDINALITY m(msg, i)
               CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(m.msg -> 'parts') = 'array' THEN m.msg -> 'parts' ELSE '[]'::jsonb END
               ) WITH ORDINALITY p(part, j)
               WHERE m.msg ->> 'role' = 'user' AND p.part ->> 'type' = 'text' AND coalesce(p.part ->> 'text', '') <> ''
               ORDER BY m.i, p.j LIMIT 1
             ) AS "firstQuestion"
      FROM ai_conversations c JOIN stores s ON s.id = c.store_id
      WHERE c.id IN (${Prisma.join(shopperIds)})
    `);
    const rows: InboxRow[] = shopperRows.map((row) => {
      const reasons = reasonsOf.get(row.id);
      return toRow("shopper", row, sampled.has(row.id), reasons ? FLAG_REASONS.filter((reason) => reasons.has(reason)) : []);
    });

    const costly = Prisma.sql`jsonb_path_exists(c.messages, '$[*] ? (@.costMicros > $t)', jsonb_build_object('t', ${costFlagMicros}::int))`;
    const copilotRows = await txQuery<Array<DbRow & { sampled: boolean; costly: boolean }>>(tx, Prisma.sql`
      SELECT ranked.id, ranked.store_id AS "storeId", s.name AS "storeName", ranked.last_message_at AS "lastMessageAt",
             ranked.message_count AS "messageCount", ranked.rn <= ${samplePerStore} AS sampled, ranked.costly,
             ranked.first_question AS "firstQuestion"
      FROM (
        SELECT c.id, c.store_id, c.last_message_at, jsonb_array_length(c.messages)::int AS message_count,
               row_number() OVER (PARTITION BY c.store_id, ${chatDay} ORDER BY md5(c.id || ${chatDay}), c.id) AS rn,
               ${costly} AS costly, ${firstTextTurn("owner")} AS first_question
        FROM copilot_conversations c
        WHERE ${inRange}
      ) ranked JOIN stores s ON s.id = ranked.store_id
      WHERE ranked.rn <= ${samplePerStore} OR ranked.costly
    `);
    for (const row of copilotRows) rows.push(toRow("copilot", row, row.sampled, row.costly ? ["costly_turn"] : []));

    const adminRows = await txQuery<Array<DbRow & { sampled: boolean; costly: boolean }>>(tx, Prisma.sql`
      SELECT ranked.id, NULL AS "storeId", NULL AS "storeName", ranked.last_message_at AS "lastMessageAt",
             ranked.message_count AS "messageCount", ranked.rn <= ${samplePerStore} AS sampled, ranked.costly,
             ranked.first_question AS "firstQuestion"
      FROM (
        SELECT c.id, c.last_message_at, jsonb_array_length(c.messages)::int AS message_count,
               row_number() OVER (PARTITION BY ${chatDay} ORDER BY md5(c.id || ${chatDay}), c.id) AS rn,
               ${costly} AS costly, ${firstTextTurn("admin")} AS first_question
        FROM admin_assistant_conversations c
        WHERE ${inRange}
      ) ranked
      WHERE ranked.rn <= ${samplePerStore} OR ranked.costly
    `);
    for (const row of adminRows) rows.push(toRow("admin", row, row.sampled, row.costly ? ["costly_turn"] : []));

    const idsOf = (kind: ConversationKind) => rows.filter((row) => row.kind === kind).map((row) => row.id);
    const flags = rows.length === 0 ? [] : await tx.aiReviewFlag.findMany({
      where: {
        OR: [
          { aiConversationId: { in: idsOf("shopper") } },
          { copilotConversationId: { in: idsOf("copilot") } },
          { adminAssistantConversationId: { in: idsOf("admin") } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { label: true, aiConversationId: true, copilotConversationId: true, adminAssistantConversationId: true },
    });
    const labelsOf = new Map<string, ReviewLabel[]>();
    for (const flag of flags) {
      const key = flag.aiConversationId ? `shopper:${flag.aiConversationId}`
        : flag.copilotConversationId ? `copilot:${flag.copilotConversationId}`
        : `admin:${flag.adminAssistantConversationId}`;
      labelsOf.set(key, [...(labelsOf.get(key) ?? []), flag.label as ReviewLabel]);
    }
    for (const row of rows) row.labels = labelsOf.get(chatKey(row)) ?? [];

    const all = orderInbox(rows);
    const shown = filterInbox(all, filters);
    const stores = await tx.store.findMany({ select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
    return {
      day,
      from,
      to,
      filters,
      rows: shown.slice(0, LIST_CAP),
      hidden: Math.max(0, shown.length - LIST_CAP),
      total: all.length,
      counts: inboxCounts(all, filters),
      samplePerStore,
      stores,
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
  /** Null for a platform admin assistant chat, which belongs to no store; its times show in UTC. */
  storeId: string | null;
  storeName: string | null;
  storeTimezone: string;
  /** The platform admin who asked, on a platform admin assistant chat. */
  askedBy: string | null;
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
  kind: z.enum(CONVERSATION_KINDS),
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
    const audit = (storeId: string | null, entityType: string) => tx.auditLog.create({
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
        askedBy: null,
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

    if (kind === "admin") {
      const row = await tx.adminAssistantConversation.findUnique({
        where: { id },
        select: {
          id: true,
          model: true,
          costMicros: true,
          createdAt: true,
          lastMessageAt: true,
          messages: true,
          user: { select: { email: true } },
          flags: FLAG_SELECT,
        },
      });
      if (!row) return null;
      await audit(null, "admin_assistant_conversation");
      return {
        kind,
        id: row.id,
        storeId: null,
        storeName: null,
        storeTimezone: "UTC",
        askedBy: row.user.email,
        model: row.model,
        costMicros: Number(row.costMicros),
        createdAt: row.createdAt.toISOString(),
        lastMessageAt: row.lastMessageAt.toISOString(),
        messages: copilotTranscript(row.messages, "admin"),
        actions: [],
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
      askedBy: null,
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
