import { findOrderSearchRows, platformAdminTransaction } from "../db";
import { encodeOrderCursor, ORDER_SEARCH_PAGE_SIZE, type OrderSearchFilters, type OrderSearchRow } from "./order-search";

/**
 * One page of orders across stores, newest first, keyset-paged on (created_at, id). Every filter is an exact
 * comparison. Date bounds are store days; the day-wide UTC bounds next to them let the created_at index narrow first.
 */
export async function searchOrders(
  filters: OrderSearchFilters,
  opts?: { pageSize?: number },
): Promise<{ rows: OrderSearchRow[]; nextCursor: string | null }> {
  const pageSize = opts?.pageSize ?? ORDER_SEARCH_PAGE_SIZE;
  const rows = await findOrderSearchRows(filters, pageSize + 1);

  const page = rows.slice(0, pageSize).map((row) => ({
    id: row.id,
    storeName: row.store_name,
    storeTimezone: row.store_timezone,
    number: row.number,
    status: row.status,
    fulfillment: row.fulfillment,
    totalAuthorizedCents: row.total_authorized_cents,
    capturedAmountCents: row.captured_amount_cents,
    createdAt: row.created_at,
  }));
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > pageSize && last ? encodeOrderCursor({ createdAt: last.createdAt, id: last.id }) : null };
}

/** Every store for the search form's store list, by name. Callers check the platform admin first. */
export async function listOrderSearchStores(): Promise<Array<{ id: string; name: string }>> {
  return platformAdminTransaction((tx) => tx.store.findMany({ select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }));
}
