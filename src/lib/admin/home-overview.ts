type Day = { day: string; orders: number; goodsCents: number };
type StoreSales = { storeId: string; today: { orders: number; goodsCents: number } };

export type HomeOverview = {
  today: { orders: number; goodsCents: number; weekAgoGoodsCents: number; changePercent: number | null };
  /** The last seven days, oldest first, for the sparklines. */
  spark: Day[];
  storesToday: Array<{ id: string; name: string; metro: string | null; goodsCents: number; orders: number }>;
  /** Today's sales by metro, most first; `null` holds the stores in no metro. */
  byMetro: Array<{ metro: string | null; goodsCents: number }>;
};

/**
 * The admin Home's figures (#859) from eight store days of platform sales (today last) and each store's sales today.
 * Goods sales are what the store analytics page calls sales: captured less fees, tip and delivery.
 */
export function homeOverview({ days, sales, stores, metros }: {
  days: Day[];
  sales: StoreSales[];
  stores: Array<{ id: string; name: string; metroId: string | null }>;
  metros: Array<{ id: string; name: string }>;
}): HomeOverview {
  const today = days[days.length - 1] ?? { day: "", orders: 0, goodsCents: 0 };
  const weekAgo = days.length >= 8 ? days[days.length - 8]!.goodsCents : 0;
  const metroName = new Map(metros.map((metro) => [metro.id, metro.name]));
  const storeById = new Map(stores.map((store) => [store.id, store]));

  const storesToday = sales.flatMap(({ storeId, today: sold }) => {
    const store = storeById.get(storeId);
    if (!store || sold.orders === 0) return [];
    return [{ id: store.id, name: store.name, metro: store.metroId ? metroName.get(store.metroId) ?? null : null, goodsCents: sold.goodsCents, orders: sold.orders }];
  }).sort((a, b) => b.goodsCents - a.goodsCents || a.name.localeCompare(b.name));

  const byMetro = new Map<string | null, number>();
  for (const row of storesToday) byMetro.set(row.metro, (byMetro.get(row.metro) ?? 0) + row.goodsCents);

  return {
    today: {
      orders: today.orders,
      goodsCents: today.goodsCents,
      weekAgoGoodsCents: weekAgo,
      changePercent: weekAgo > 0 ? Math.round(((today.goodsCents - weekAgo) / weekAgo) * 100) : null,
    },
    spark: days.slice(-7),
    storesToday,
    byMetro: [...byMetro].map(([metro, goodsCents]) => ({ metro, goodsCents }))
      .sort((a, b) => (a.metro === null ? 1 : 0) - (b.metro === null ? 1 : 0) || b.goodsCents - a.goodsCents),
  };
}
