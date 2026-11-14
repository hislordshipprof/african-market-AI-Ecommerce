import { Prisma, storeScopedRawQuery } from "../db";
import {
  isDisplayState,
  isProposalKind,
  type ProposalDisplayState,
  type ProposalKind,
  type StockProposalCard,
} from "./types";

export function listingLabel(listing: {
  customName: string | null;
  masterProduct?: { name: string } | null;
}): string {
  return listing.customName?.trim() || listing.masterProduct?.name?.trim() || "Unnamed";
}

export function readBefore(value: unknown): { qty: number | null; status: string | null } {
  if (!value || typeof value !== "object") return { qty: null, status: null };
  const qty = (value as { qty?: unknown }).qty;
  const status = (value as { status?: unknown }).status;
  return {
    qty: typeof qty === "number" ? qty : null,
    status: typeof status === "string" ? status : null,
  };
}

export function cardFromParts(input: {
  id: string;
  listingId: string;
  listingName: string;
  kind: string;
  quantity: number | null;
  statusValue: string | null;
  before: unknown;
  state: string;
}): StockProposalCard {
  const kind: ProposalKind = isProposalKind(input.kind) ? input.kind : "recount";
  const state: ProposalDisplayState = isDisplayState(input.state) ? input.state : "pending";
  const before = readBefore(input.before);
  let afterQty: number | null = null;
  let afterStatus: string | null = null;
  if (kind === "restock") afterQty = (before.qty ?? 0) + (input.quantity ?? 0);
  if (kind === "counter_sale") afterQty = Math.max(0, (before.qty ?? 0) - (input.quantity ?? 0));
  if (kind === "recount") afterQty = input.quantity;
  if (kind === "set_status") afterStatus = input.statusValue;
  return {
    id: input.id,
    listingId: input.listingId,
    listingName: input.listingName,
    kind,
    quantity: input.quantity,
    statusValue: input.statusValue,
    beforeQty: before.qty,
    beforeStatus: before.status,
    afterQty,
    afterStatus,
    state,
  };
}

interface CardRow {
  id: string;
  listing_id: string;
  listing_name: string;
  kind: string;
  quantity: number | null;
  status_value: string | null;
  before: unknown;
  display_state: string;
}

export async function loadProposalCards(
  storeId: string,
  filter: { conversationId: string } | { messageId: string },
): Promise<StockProposalCard[]> {
  const where = "conversationId" in filter
    ? Prisma.sql`p.conversation_id = ${filter.conversationId}`
    : Prisma.sql`p.client_message_id = ${filter.messageId}`;
  const rows = await storeScopedRawQuery<CardRow>(
    storeId,
    Prisma.sql`
      SELECT p.id, p.listing_id, p.kind, p.quantity, p.status_value, p.before,
        COALESCE(NULLIF(btrim(l.custom_name), ''), NULLIF(btrim(mp.name), ''), 'Unnamed') AS listing_name,
        CASE
          WHEN p.state = 'pending' AND p.expires_at <= (clock_timestamp() AT TIME ZONE 'UTC') THEN 'expired'
          ELSE p.state
        END AS display_state
      FROM stock_proposals p
      JOIN listings l ON l.id = p.listing_id
      LEFT JOIN master_products mp ON mp.id = l.master_product_id
      WHERE ${where}
      ORDER BY p.created_at ASC, p.id ASC
    `,
  );
  return rows.map((row) => cardFromParts({
    id: row.id,
    listingId: row.listing_id,
    listingName: row.listing_name,
    kind: row.kind,
    quantity: row.quantity,
    statusValue: row.status_value,
    before: row.before,
    state: row.display_state,
  }));
}
