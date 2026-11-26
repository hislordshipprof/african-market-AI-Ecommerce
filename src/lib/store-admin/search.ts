import { storeScoped } from "../db";
import { listingLabel } from "../copilot/cards";
import { ACTIVE_STATUSES } from "../order/service";
import { orderSearchWhere } from "../order/past-orders";

const EACH = 5;

export interface AdminSearchResults {
  orders: { id: string; number: number; customerName: string; status: string; fulfillment: string; active: boolean }[];
  products: { id: string; name: string }[];
  customers: { id: string; name: string }[];
}

/** The top bar's search (#860): orders by number or customer, products by name, customers by name, email or phone. */
export async function searchStoreAdmin(storeId: string, raw: string): Promise<AdminSearchResults> {
  const q = raw.trim().slice(0, 100);
  if (!q) return { orders: [], products: [], customers: [] };
  const scoped = storeScoped(storeId);
  const contains = { contains: q, mode: "insensitive" as const };
  const digits = q.replace(/\D/g, "");
  const [orders, products, customers] = await Promise.all([
    scoped.order.findMany({
      where: orderSearchWhere(q),
      select: { id: true, number: true, status: true, fulfillment: true, customer: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: EACH,
    }),
    scoped.listing.findMany({
      where: { OR: [{ customName: contains }, { customName: null, masterProduct: { name: contains } }] },
      select: { id: true, customName: true, masterProduct: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: EACH,
    }),
    scoped.customer.findMany({
      where: {
        claimedByCustomerId: null,
        OR: [{ name: contains }, { email: contains }, ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : [])],
      },
      select: { id: true, name: true },
      orderBy: { createdAt: "desc" },
      take: EACH,
    }),
  ]);
  return {
    orders: orders.map((order) => ({
      id: order.id,
      number: order.number,
      customerName: order.customer.name,
      status: order.status,
      fulfillment: order.fulfillment,
      active: (ACTIVE_STATUSES as string[]).includes(order.status),
    })),
    products: products.map((listing) => ({ id: listing.id, name: listingLabel(listing) })),
    customers,
  };
}
