import { Prisma, lockListingRow, lockStoreRow, platform, storeScopedRawQuery, storeScopedTransaction, txQuery } from "../db";
import { addDays, validDay } from "../analytics/range";
import { parseCouponForm, storeLocalToUtc, utcToStoreLocal, type CouponInput } from "../coupon/form";
import { couponError, insertCoupon } from "../coupon/service";
import { updateListingInTransaction } from "../listing/service";
import { normalizedSearchQuery } from "../storefront/search-query";
import {
  storeChangeBefore,
  storeChangeEndsAt,
  storeChangeError,
  storeChangeText,
  writeStoreChange,
  type StoreChange,
} from "../store-settings/store-change";
import { readWeeklyHours, WEEK_DAYS } from "../store-settings/weekly-hours";
import { searchListingMatches } from "./search";
import {
  DRAFT_HOURS,
  PRICE_LINES_MAX,
  WRITE_TRANSACTION,
  isDisplayState,
  type CopilotActor,
  type CouponFields,
  type DraftCard,
  type DraftConfirmResult,
  type DraftKind,
  type PriceLine,
} from "./types";

type Tx = Parameters<Parameters<typeof storeScopedTransaction>[1]>[0];

/**
 * A coupon, price or store-change draft from one turn (#819). The terms go in `payload`, what the confirm checks is
 * unchanged in `before`. Nothing is written until the owner confirms.
 */
export type PendingDraft =
  | { kind: "coupon"; payload: CouponFields; before: Record<string, never> }
  | { kind: "price"; payload: { lines: PriceLine[]; applied?: string[] }; before: Record<string, number> }
  | { kind: "store_change"; payload: StoreChange; before: Record<string, string | null> };

/** A draft the tool refused; its message goes back to the model. */
export class DraftError extends Error {}

const FIELD_NAMES = ["code", "kind", "percentOff", "amountOff", "minGoods", "startsAt", "endsAt", "totalUses", "usesPerCustomer", "firstOrderOnly"] as const;

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formOf(fields: CouponFields): FormData {
  const form = new FormData();
  for (const name of FIELD_NAMES) form.set(name, fields[name]);
  return form;
}

/** The promotions form's validation, run on the draft's fields; the one rule set for a coupon. */
function parseCoupon(fields: CouponFields, timeZone: string) {
  return parseCouponForm(formOf(fields), timeZone);
}

function fieldsOf(input: CouponInput, timeZone: string): CouponFields {
  return {
    code: input.code,
    kind: input.kind,
    percentOff: input.percentOff === null ? "" : String(input.percentOff),
    amountOff: input.amountOffCents === null ? "" : (input.amountOffCents / 100).toFixed(2),
    minGoods: (input.minGoodsCents / 100).toFixed(2),
    startsAt: utcToStoreLocal(input.startsAt, timeZone),
    endsAt: input.endsAt ? utcToStoreLocal(input.endsAt, timeZone) : "",
    totalUses: input.totalUses === null ? "" : String(input.totalUses),
    usesPerCustomer: input.usesPerCustomer === null ? "" : String(input.usesPerCustomer),
    firstOrderOnly: input.firstOrderOnly ? "on" : "",
  };
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

/** Checks a coupon exactly as the promotions page does and returns its draft. */
export function draftCoupon(input: CouponDraftInput, timeZone: string): PendingDraft & { kind: "coupon" } {
  const text = (value: number | undefined) => (value === undefined ? "" : String(value));
  const parsed = parseCoupon({
    code: input.code,
    kind: input.amountOff !== undefined && input.percentOff === undefined ? "fixed" : "percent",
    percentOff: text(input.percentOff),
    amountOff: text(input.amountOff),
    minGoods: text(input.minGoods),
    startsAt: input.startsAt,
    endsAt: input.endsAt ?? "",
    totalUses: text(input.totalUses),
    usesPerCustomer: text(input.usesPerCustomer),
    firstOrderOnly: input.firstOrderOnly ? "on" : "",
  }, timeZone);
  if (!parsed.ok) throw new DraftError(parsed.error);
  return { kind: "coupon", payload: fieldsOf(parsed.data, timeZone), before: {} };
}

export interface PriceDraftInput {
  query: string;
  variant?: string;
  change: "add" | "set";
  cents: number;
}

const PRICE_MAX_CENTS = 1_000_000;

function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Price lines for the listings the owner named. Every word of the search must be in the owner's message, so the
 * model cannot price an item the owner did not name. At most 20 lines; never below $0.01.
 */
export async function draftPrices(storeId: string, input: PriceDraftInput, ownerText: string): Promise<PendingDraft & { kind: "price" }> {
  const owner = ownerText.toLowerCase();
  const words = normalizedSearchQuery(input.query).query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0 || words.some((word) => !owner.includes(word))) {
    throw new DraftError("search only for the item as the owner named it in this message");
  }
  const found = await searchListingMatches(storeId, input.query, PRICE_LINES_MAX + 1);
  if (found.outcome === "none" || found.nearOnly) {
    throw new DraftError(`no item matches ${input.query}; ask the owner which item they mean`);
  }
  const listings = await storeScopedRawQuery<{ listing_id: string; variant_id: string; label: string; price: number }>(
    storeId,
    Prisma.sql`
      SELECT v.listing_id, v.id AS variant_id, v.label, v.price
      FROM listing_variants v
      WHERE v.listing_id IN (${Prisma.join(found.listings.map((listing) => listing.id))})
      ORDER BY v.listing_id, v.price, v.id
    `,
  );
  const names = new Map(found.listings.map((listing) => [listing.id, listing.name]));
  const size = input.variant ? squash(input.variant) : null;
  const lines: PriceLine[] = [];
  for (const row of listings) {
    if (size && squash(row.label) !== size) continue;
    const after = input.change === "add" ? row.price + input.cents : input.cents;
    if (after === row.price) continue;
    if (after < 1) throw new DraftError(`${names.get(row.listing_id)} ${row.label} would go below $0.01`);
    if (after > PRICE_MAX_CENTS) throw new DraftError("prices go up to $10,000");
    lines.push({
      listingId: row.listing_id,
      variantId: row.variant_id,
      name: `${names.get(row.listing_id)} ${row.label}`,
      beforeCents: row.price,
      afterCents: after,
    });
  }
  if (lines.length === 0) throw new DraftError(size ? `no ${input.variant} size matches, or it is already that price` : "already at that price");
  if (lines.length > PRICE_LINES_MAX) throw new DraftError("more than 20 prices match; ask the owner to name the item more exactly");
  lines.sort((a, b) => a.name.localeCompare(b.name));
  return {
    kind: "price",
    payload: { lines },
    before: Object.fromEntries(lines.map((line) => [line.variantId, line.beforeCents])),
  };
}

export interface StoreChangeDraftInput {
  change: "closed" | "hours" | "pause_delivery";
  date?: string;
  open?: string;
  close?: string;
  until?: string;
}

/** A one-day hours change or a delivery pause; the weekly hours are never changed here. */
export function draftStoreChange(
  input: StoreChangeDraftInput,
  store: { hours: unknown; timezone: string; deliveryPausedUntil: Date | null },
  now: Date,
): PendingDraft & { kind: "store_change" } {
  let change: StoreChange;
  if (input.change === "pause_delivery") {
    const until = input.until ?? "";
    const end = validDay(until)
      ? storeLocalToUtc(`${addDays(until, 1)}T00:00`, store.timezone)
      : storeLocalToUtc(until, store.timezone);
    if (!end) throw new DraftError("give until as YYYY-MM-DD or YYYY-MM-DDTHH:MM");
    change = { kind: "delivery_pause", until: end.toISOString() };
  } else {
    const date = input.date ?? "";
    if (!validDay(date)) throw new DraftError("give the date as YYYY-MM-DD");
    const week = readWeeklyHours(store.hours);
    if (!week) throw new DraftError("the store has no weekly hours yet; the owner sets them under Settings");
    if (input.change === "closed") {
      change = { kind: "day_hours", date, closed: true };
    } else {
      const usual = week.week[WEEK_DAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7]];
      if (usual.closed && (!input.open || !input.close)) throw new DraftError("the store is usually closed that day; ask for both times");
      change = { kind: "day_hours", date, closed: false, open: input.open ?? usual.open, close: input.close ?? usual.close };
    }
  }
  const refused = storeChangeError(change, store.timezone, now);
  if (refused) throw new DraftError(refused);
  return { kind: "store_change", payload: change, before: storeChangeBefore(store, change) };
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
  return { drafted: true, change: storeChangeText(draft.payload, timeZone, now), note };
}

interface DraftRow {
  id: string;
  kind: string;
  payload: unknown;
  state: string;
  expiresAt: string;
}

function cardOf(row: DraftRow, timeZone: string, now: Date): DraftCard {
  const base = { id: row.id, state: isDisplayState(row.state) ? row.state : "pending", expiresAt: row.expiresAt } as const;
  if (row.kind === "coupon") {
    const fields = row.payload as CouponFields;
    return { ...base, kind: "coupon", fields, summary: couponSummary(fields) };
  }
  if (row.kind === "price") {
    const payload = row.payload as { lines: PriceLine[]; applied?: string[] };
    return { ...base, kind: "price", lines: payload.lines, applied: payload.applied ?? null };
  }
  const change = row.payload as StoreChange;
  return {
    ...base,
    kind: "store_change",
    text: storeChangeText(change, timeZone, now),
    endsAt: storeChangeEndsAt(change, timeZone).toISOString(),
  };
}

const CLOCK_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`;

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

export interface DraftEdits {
  coupon?: CouponFields;
  variantIds?: string[];
}

const NOT_FOUND: DraftConfirmResult = { ok: false, code: "not_found", message: "That draft is no longer waiting. Ask again if you still need it." };
const EXPIRED: DraftConfirmResult = { ok: false, code: "expired", message: "This draft expired after 24 hours. Ask again if you still need it." };
const STALE: DraftConfirmResult = {
  ok: false,
  code: "stale",
  message: "Something changed since this was drafted, so nothing was applied. Ask again for a fresh draft.",
};
const invalid = (message: string): DraftConfirmResult => ({ ok: false, code: "invalid", message });

async function loadRow(tx: Tx, draftId: string) {
  const [row] = await txQuery<Array<{ id: string; kind: DraftKind; payload: unknown; before: unknown; state: string; expires_at: string; expired: boolean }>>(tx, Prisma.sql`
    SELECT id, kind, payload, before, state, to_char(expires_at, ${CLOCK_FORMAT}) AS expires_at,
      expires_at <= (clock_timestamp() AT TIME ZONE 'UTC') AS expired
    FROM copilot_drafts WHERE id = ${draftId}
  `);
  return row ?? null;
}

async function settle(tx: Tx, draftId: string, state: "confirmed" | "rejected" | "expired", actor: CopilotActor | null, payload?: unknown) {
  await tx.copilotDraft.update({
    where: { id: draftId },
    data: {
      state,
      ...(actor ? { decidedById: actor.id, decidedAt: new Date() } : {}),
      ...(payload !== undefined ? { payload: payload as Prisma.InputJsonValue } : {}),
    },
  });
}

/** Changed prices by variant for the ticked lines, or null when a line no longer matches what was drafted. */
async function applyPrices(tx: Tx, storeId: string, lines: PriceLine[], before: Record<string, number>, actor: CopilotActor): Promise<boolean> {
  const byListing = new Map<string, PriceLine[]>();
  for (const line of lines) byListing.set(line.listingId, [...(byListing.get(line.listingId) ?? []), line]);
  const updates: Array<{ listingId: string; variants: Awaited<ReturnType<Tx["listingVariant"]["findMany"]>>; changed: Map<string, number> }> = [];
  for (const listingId of [...byListing.keys()].sort()) {
    await lockListingRow(tx, listingId);
    const variants = await tx.listingVariant.findMany({ where: { listingId }, orderBy: { id: "asc" } });
    const changed = new Map<string, number>();
    for (const line of byListing.get(listingId)!) {
      const current = variants.find((variant) => variant.id === line.variantId);
      if (!current || current.price !== before[line.variantId]) return false;
      changed.set(line.variantId, line.afterCents);
    }
    updates.push({ listingId, variants, changed });
  }
  for (const { listingId, variants, changed } of updates) {
    const next = variants.map((variant) => ({
      id: variant.id,
      label: variant.label,
      price: changed.get(variant.id) ?? variant.price,
      weightG: variant.weightG,
      weightPlaceholder: variant.weightPlaceholder,
      sku: variant.sku,
      barcode: variant.barcode,
    }));
    await updateListingInTransaction(tx, {
      storeId,
      listingId,
      price: Math.min(...next.map((variant) => variant.price)),
      variants: next,
      actor,
    });
  }
  return true;
}

/**
 * Applies a pending draft through the store's own services: the coupon through the promotions page's validation and
 * write, prices through the listing price path, a store change through the owner settings service. A draft past 24
 * hours expires; one whose prices or hours changed since asks again. Callers authenticate the owner before this.
 */
export async function confirmDraft(storeId: string, draftId: string, actor: CopilotActor, edits: DraftEdits = {}): Promise<DraftConfirmResult> {
  let couponCode = "";
  try {
    return await storeScopedTransaction(storeId, async (tx) => {
      const store = await lockStoreRow(tx, storeId);
      const now = new Date();
      const row = await loadRow(tx, draftId);
      if (!row) return NOT_FOUND;
      const card = (state: string, payload: unknown = row.payload) => cardOf({ id: row.id, kind: row.kind, payload, state, expiresAt: row.expires_at }, store.timezone, now);
      if (row.state === "confirmed") return { ok: true, draft: card("confirmed") };
      if (row.state === "expired") return EXPIRED;
      if (row.state !== "pending") return NOT_FOUND;
      if (row.expired) {
        await settle(tx, draftId, "expired", null);
        return EXPIRED;
      }

      let payload = row.payload;
      if (row.kind === "coupon") {
        const fields = edits.coupon ?? (row.payload as CouponFields);
        const parsed = parseCoupon(fields, store.timezone);
        if (!parsed.ok) return invalid(parsed.error);
        couponCode = parsed.data.code;
        await insertCoupon(tx, { storeId, actorId: actor.id, actorEmail: actor.email }, parsed.data);
        payload = fieldsOf(parsed.data, store.timezone);
      } else if (row.kind === "price") {
        const lines = (row.payload as { lines: PriceLine[] }).lines;
        const ticked = edits.variantIds ? lines.filter((line) => edits.variantIds!.includes(line.variantId)) : lines;
        if (ticked.length === 0) return invalid("Tick at least one price, or dismiss the draft.");
        if (edits.variantIds && ticked.length !== new Set(edits.variantIds).size) return NOT_FOUND;
        if (!(await applyPrices(tx, storeId, ticked, row.before as Record<string, number>, actor))) {
          await settle(tx, draftId, "expired", null);
          return STALE;
        }
        payload = { lines, applied: ticked.map((line) => line.variantId) };
      } else {
        const change = row.payload as StoreChange;
        const current = storeChangeBefore(store, change);
        const before = row.before as Record<string, string | null>;
        const unchanged = Object.keys(current).every((key) => current[key] === before[key]);
        if (!unchanged || storeChangeError(change, store.timezone, now)) {
          await settle(tx, draftId, "expired", null);
          return STALE;
        }
        await writeStoreChange(tx, storeId, change, actor, now);
      }
      await settle(tx, draftId, "confirmed", actor, payload);
      return { ok: true, draft: card("confirmed", payload) };
    }, WRITE_TRANSACTION);
  } catch (error) {
    const duplicate = couponError(error, couponCode);
    if (duplicate) return invalid(duplicate);
    throw error;
  }
}

/** Dismisses a pending draft; nothing is written. */
export async function rejectDraft(storeId: string, draftId: string, actor: CopilotActor): Promise<{ ok: true } | { ok: false; code: "not_found" }> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const row = await loadRow(tx, draftId);
    if (!row || row.state !== "pending") return { ok: false, code: "not_found" } as const;
    await settle(tx, draftId, "rejected", actor);
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "copilot.draft_rejected",
        entityType: "copilot_draft",
        entityId: draftId,
        before: { state: "pending" },
        after: { kind: row.kind },
      },
    });
    return { ok: true } as const;
  }, WRITE_TRANSACTION);
}

/** The store row a store-change confirm revalidates. */
export async function storeSite(storeId: string) {
  return platform.store.findUnique({ where: { id: storeId }, select: { id: true, slug: true, customDomain: true } });
}
