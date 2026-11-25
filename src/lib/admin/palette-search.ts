"use server";

import { platformAdminTransaction } from "../db";
import { parsePaletteQuery } from "./palette-query";
import { searchOrders } from "./order-search-query";
import { requirePlatformAdmin } from "./session";

const STORES_SHOWN = 5;
/** An order number is looked up in the first few stores the words match; order numbers are per store. */
const STORES_FOR_ORDERS = 3;

export type PaletteResults = {
  stores: Array<{ id: string; name: string; slug: string; status: string }>;
  orders: Array<{ id: string; storeName: string; number: number }>;
};

/** The ⌘K palette's stores and orders (#859). Read only; orders go through the order search, by store and number. */
export async function paletteSearchAction(query: string): Promise<PaletteResults> {
  await requirePlatformAdmin();
  const { text, number } = parsePaletteQuery(typeof query === "string" ? query : "");
  if (!text) return { stores: [], orders: [] };
  const stores = await platformAdminTransaction((tx) => tx.store.findMany({
    where: { OR: [{ name: { contains: text, mode: "insensitive" } }, { slug: { contains: text, mode: "insensitive" } }] },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: STORES_SHOWN,
    select: { id: true, name: true, slug: true, status: true },
  }));
  const orders = number === null ? [] : (await Promise.all(stores.slice(0, STORES_FOR_ORDERS).map(async (store) => {
    const { rows } = await searchOrders(
      { storeId: store.id, number, email: null, phone: null, status: null, fulfillment: null, from: null, to: null, cursor: null },
      { pageSize: 1 },
    );
    return rows.map((row) => ({ id: row.id, storeName: row.storeName, number: row.number }));
  }))).flat();
  return { stores, orders };
}
