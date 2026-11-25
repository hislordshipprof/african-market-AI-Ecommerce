import { Prisma, lockStoreRow, storeScopedRawQuery, storeScopedTransaction, txQuery } from "../db";
import { storeChangeEndsAt, storeChangeText, type StoreChange } from "../store-settings/store-change";
import { pauseEndLabel } from "../delivery/delivery-pause";
import { DRAFT_HOURS, isDisplayState, type CouponFields, type DraftCard, type PriceLine } from "./types";

type Tx = Parameters<Parameters<typeof storeScopedTransaction>[1]>[0];

/**
 * The draft rows and cards (#819), which the WhatsApp channel also loads. No coupon, listing or payment module is
 * imported here: the assistant import boundary (#557, #559) keeps those out of WhatsApp's reach. The page passes
 * the draft makers in (`DraftMakers`).
 */

export interface CouponDraftInput {
  code: string;
  percentOff?: number;
  amountOff?: number;
  minGoods?: number;
  startsAt: string;
  endsAt?: string;
  totalUses?: number;
  usesPerCustomer?: number;
  firstOrderOnly?: boolean;
}

export interface PriceDraftInput {
  query: string;
  variant?: string;
  change: "add" | "set";
  cents: number;
}

export interface StoreChangeDraftInput {
  change: "closed" | "hours" | "pause_delivery";
  date?: string;
  open?: string;
  close?: string;
  until?: string;
}

export interface DescriptionDraftInput {
  listingId: string;
  text: string;
}

/** The page's draft makers, passed into the turn so the copilot modules WhatsApp reaches never import them. */
export interface DraftMakers {
  coupon(input: CouponDraftInput, timeZone: string): PendingDraft;
  prices(storeId: string, input: PriceDraftInput, ownerText: string): Promise<PendingDraft>;
  storeChange(input: StoreChangeDraftInput, store: { hours: unknown; timezone: string; deliveryPausedUntil: Date | null }, now: Date): PendingDraft;
  /** `facts` is the listing_facts result the model read this turn (#820). */
  description(input: DescriptionDraftInput, facts: DescriptionFacts): PendingDraft;
}

/** What a description draft is checked against: the listing's facts as the model read them. */
export interface DescriptionFacts {
  listingId: string;
  name: string;
  currentDescription: string | null;
  /** The facts as JSON; a number in the draft must appear here. */
  text: string;
}

/**
 * A coupon, price or store-change draft from one turn (#819). The terms go in `payload`, what the confirm checks is
 * unchanged in `before`. Nothing is written until the owner confirms.
 */
export type PendingDraft =
  | { kind: "coupon"; payload: CouponFields; before: Record<string, never> }
  | { kind: "price"; payload: { lines: PriceLine[]; applied?: string[] }; before: Record<string, number> }
  | { kind: "store_change"; payload: StoreChange; before: Record<string, string | null> }
  | { kind: "description"; payload: { listingId: string; name: string; text: string }; before: { description: string | null } };

/** A draft the tool refused; its message goes back to the model. */
export class DraftError extends Error {}

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function localLabel(local: string): string {
  const at = new Date(`${local}:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(at).replace(/,/g, "");
}

/** The coupon's terms in one sentence, for the card and the model. */
export function couponSummary(fields: CouponFields): string {
  const off = fields.kind === "percent" ? `${fields.percentOff}% off` : `$${fields.amountOff} off`;
  const minimum = Number(fields.minGoods) > 0 ? ` orders of $${fields.minGoods} or more` : " any order";
  const window = fields.endsAt
    ? `from ${localLabel(fields.startsAt)} to ${localLabel(fields.endsAt)}`
    : `from ${localLabel(fields.startsAt)}, with no end`;
  const limits = [
    fields.totalUses ? `${fields.totalUses} uses in all` : "",
    fields.usesPerCustomer ? `${fields.usesPerCustomer} per customer` : "",
    fields.firstOrderOnly === "on" ? "first orders only" : "",
  ].filter(Boolean);
  return `${fields.code}: ${off}${minimum}, ${window}. ${limits.length ? `Limits: ${limits.join(", ")}.` : "No use limits."}`;
}

/** What the model is told a draft says; numbers in it may be quoted. */
export function draftToolResult(draft: PendingDraft, timeZone: string, now: Date) {
  const note = "Drafted. Nothing changes until the owner confirms on screen.";
  if (draft.kind === "coupon") return { drafted: true, coupon: couponSummary(draft.payload), note };
  if (draft.kind === "price") {
    return {
      drafted: true,
      prices: draft.payload.lines.map((line) => `${line.name}: ${dollars(line.beforeCents)} to ${dollars(line.afterCents)}`),
      note: `${note} The owner can untick lines.`,
    };
  }
  if (draft.kind === "description") return { drafted: true, listing: draft.payload.name, description: draft.payload.text, note };
  return { drafted: true, change: storeChangeText(draft.payload, timeZone, now), note };
}

interface DraftRow {
  id: string;
  kind: string;
  payload: unknown;
  state: string;
  expiresAt: string;
}

export function cardOf(row: DraftRow, timeZone: string, now: Date): DraftCard {
  const base = { id: row.id, state: isDisplayState(row.state) ? row.state : "pending", expiresAt: row.expiresAt } as const;
  if (row.kind === "coupon") {
    const fields = row.payload as CouponFields;
    return { ...base, kind: "coupon", fields, summary: couponSummary(fields) };
  }
  if (row.kind === "price") {
    const payload = row.payload as { lines: PriceLine[]; applied?: string[] };
    return { ...base, kind: "price", lines: payload.lines, applied: payload.applied ?? null };
  }
  if (row.kind === "description") {
    const payload = row.payload as { listingId: string; name: string; text: string };
    return { ...base, kind: "description", listingId: payload.listingId, name: payload.name, text: payload.text };
  }
  const change = row.payload as StoreChange;
  const endsAt = storeChangeEndsAt(change, timeZone);
  return {
    ...base,
    kind: "store_change",
    text: storeChangeText(change, timeZone, now),
    endsAt: endsAt.toISOString(),
    ends: pauseEndLabel(endsAt, timeZone, now),
  };
}

export const CLOCK_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`;

/** Stores this turn's drafts, 24 hours to confirm, with one `copilot.draft_proposed` audit row each. */
export async function insertDraftRows(
  tx: Tx,
  input: { storeId: string; conversationId: string; messageId: string; userId: string; email: string },
  drafts: readonly PendingDraft[],
): Promise<DraftCard[]> {
  if (drafts.length === 0) return [];
  const store = await lockStoreRow(tx, input.storeId);
  const now = new Date();
  const cards: DraftCard[] = [];
  for (const draft of drafts) {
    const id = crypto.randomUUID();
    const [row] = await txQuery<Array<{ expires_at: string }>>(tx, Prisma.sql`
      INSERT INTO copilot_drafts (id, store_id, conversation_id, client_message_id, kind, payload, before, state, expires_at)
      VALUES (${id}, ${input.storeId}, ${input.conversationId}, ${input.messageId}, ${draft.kind},
        ${JSON.stringify(draft.payload)}::jsonb, ${JSON.stringify(draft.before)}::jsonb, 'pending',
        (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(hours => ${DRAFT_HOURS}))
      RETURNING to_char(expires_at, ${CLOCK_FORMAT}) AS expires_at
    `);
    await tx.auditLog.create({
      data: {
        storeId: input.storeId,
        actorId: input.userId,
        actorEmail: input.email,
        action: "copilot.draft_proposed",
        entityType: "copilot_draft",
        entityId: id,
        after: { kind: draft.kind, payload: draft.payload as Prisma.InputJsonValue },
      },
    });
    cards.push(cardOf({ id, kind: draft.kind, payload: draft.payload, state: "pending", expiresAt: row!.expires_at }, store.timezone, now));
  }
  return cards;
}

/** The drafts of a conversation or one turn, oldest first; a pending draft past its expiry shows as expired. */
export async function loadDraftCards(
  storeId: string,
  filter: { conversationId: string } | { messageId: string },
): Promise<DraftCard[]> {
  const where = "conversationId" in filter
    ? Prisma.sql`d.conversation_id = ${filter.conversationId}`
    : Prisma.sql`d.client_message_id = ${filter.messageId}`;
  const rows = await storeScopedRawQuery<{ id: string; kind: string; payload: unknown; display_state: string; expires_at: string; timezone: string }>(
    storeId,
    Prisma.sql`
      SELECT d.id, d.kind, d.payload, s.timezone,
        to_char(d.expires_at, ${CLOCK_FORMAT}) AS expires_at,
        CASE
          WHEN d.state = 'pending' AND d.expires_at <= (clock_timestamp() AT TIME ZONE 'UTC') THEN 'expired'
          ELSE d.state
        END AS display_state
      FROM copilot_drafts d
      JOIN stores s ON s.id = d.store_id
      WHERE ${where}
      ORDER BY d.created_at ASC, d.id ASC
    `,
  );
  const now = new Date();
  return rows.map((row) => cardOf({ id: row.id, kind: row.kind, payload: row.payload, state: row.display_state, expiresAt: row.expires_at }, row.timezone, now));
}

