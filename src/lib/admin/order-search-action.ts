"use server";

import { readFormFields } from "../security/parse-input";
import { requirePlatformAdmin } from "./session";
import { ORDER_SEARCH_FIELDS, parseOrderSearch, type OrderSearchState } from "./order-search";
import { searchOrders } from "./order-search-query";

/** Read only. A POST, so a customer's email or phone never sits in a URL or a request log. */
export async function searchOrdersAction(previous: OrderSearchState, formData: FormData): Promise<OrderSearchState> {
  await requirePlatformAdmin();
  const fields = readFormFields(formData, ORDER_SEARCH_FIELDS);
  const values: OrderSearchState["values"] = {};
  for (const name of ORDER_SEARCH_FIELDS) {
    const value = fields[name];
    if (typeof value === "string" && name !== "cursor") values[name] = value;
  }
  // A cursor belongs to the search that produced it; changed filters start over at page 1.
  const sameSearch = ORDER_SEARCH_FIELDS.every((name) => name === "cursor" || (values[name] ?? "") === (previous.values[name] ?? ""));
  const parsed = parseOrderSearch(sameSearch ? fields : { ...fields, cursor: undefined });
  if (!parsed.ok) return { values, error: parsed.error, rows: null, nextCursor: null, page: 0 };
  const { rows, nextCursor } = await searchOrders(parsed.filters);
  return { values, error: null, rows, nextCursor, page: parsed.filters.cursor ? previous.page + 1 : 1 };
}
