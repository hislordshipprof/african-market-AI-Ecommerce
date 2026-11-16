import { storeScoped } from "../db";
import { listingLabel } from "../copilot/cards";

/** The store's active listings, by name, for picking what each supplier supplies. */
export async function listActiveListings(storeId: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await storeScoped(storeId).listing.findMany({
    where: { storeId, active: true },
    select: { id: true, customName: true, masterProduct: { select: { name: true } } },
    take: 2000,
  });
  return rows.map((row) => ({ id: row.id, name: listingLabel(row) })).sort((a, b) => a.name.localeCompare(b.name));
}
