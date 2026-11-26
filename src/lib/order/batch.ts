import { lockStoreRow, storeScopedTransaction } from "../db";
import { listingImage } from "../storefront/images";
import { RESOLVED_LINE_STATUSES, type OrderLineStatus } from "./constants";
import {
  LEDGER_TRANSACTION,
  PICKABLE_STATUSES,
  pickLineInTx,
  runPickEffects,
  shortLineInTx,
  type PickEffects,
} from "./service";
import {
  MAX_BATCH_ORDERS,
  MIN_BATCH_ORDERS,
  allocateFound,
  buildBatchPickList,
  byOrderAge,
  type BatchPickList,
  type BatchTote,
} from "./batch-pick-list";

export { ORDER_IN_BATCH } from "./service";

export const BATCH_SIZE = `Choose ${MIN_BATCH_ORDERS} to ${MAX_BATCH_ORDERS} orders to pick together`;
export const BATCH_ORDERS_NOT_BATCHABLE = "Only accepted orders that are not already in a batch can be picked together";
export const BATCH_NOT_FOUND = "Batch not found";
export const BATCH_LINE_DONE = "Nothing left to pick on this line";
export const UNITS_FOUND_PREFIX = "Units found must be a whole number from 0 to ";

type Result = { ok: true } | { ok: false; error: string };

/**
 * Staff pick 2-4 Accepted orders together (#564). Same store only: every query runs under
 * the store's RLS scope, so another store's order id is simply not found (ADR-0007).
 */
export async function startBatch(
  storeId: string,
  orderIds: string[],
): Promise<{ ok: true; batchId: string } | { ok: false; error: string }> {
  const ids = [...new Set(orderIds)];
  if (ids.length !== orderIds.length || ids.length < MIN_BATCH_ORDERS || ids.length > MAX_BATCH_ORDERS) {
    return { ok: false, error: BATCH_SIZE };
  }
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const orders = await tx.order.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, pickBatchId: true } });
    if (orders.length !== ids.length) return { ok: false as const, error: "Order not found" };
    if (orders.some((order) => order.status !== "ACCEPTED" || order.pickBatchId !== null)) {
      return { ok: false as const, error: BATCH_ORDERS_NOT_BATCHABLE };
    }
    const batch = await tx.pickBatch.create({ data: { storeId } });
    await tx.order.updateMany({ where: { id: { in: ids } }, data: { pickBatchId: batch.id } });
    return { ok: true as const, batchId: batch.id };
  });
}

type BatchTx = Parameters<Parameters<typeof storeScopedTransaction>[1]>[0];

async function openBatch(tx: BatchTx, batchId: string) {
  return tx.pickBatch.findFirst({ where: { id: batchId, closedAt: null }, select: { id: true } });
}

const VARIANT_NAME = {
  select: { label: true, listing: { select: { customName: true, masterProduct: { select: { name: true } } } } },
} as const;

function variantName(variant: { label: string; listing: { customName: string | null; masterProduct: { name: string } | null } }) {
  const name = variant.listing.customName ?? variant.listing.masterProduct?.name ?? "Unknown product";
  return `${name} ${variant.label}`;
}

export type BatchToteView = BatchTote & { readyEstimateAt: Date | null; canMarkReady: boolean };
export type PickBatchView = Omit<BatchPickList, "totes"> & {
  batchId: string;
  packingStarted: boolean;
  totes: BatchToteView[];
};

/** The packing screen's data: the combined list plus each order's tote and status. Null when closed or not this store's. */
export async function readPickBatch(storeId: string, batchId: string): Promise<PickBatchView | null> {
  const orders = await storeScopedTransaction(storeId, async (tx) => {
    if (!(await openBatch(tx, batchId))) return null;
    return tx.order.findMany({
      where: { pickBatchId: batchId },
      include: {
        lines: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          include: {
            substituteVariant: VARIANT_NAME,
            listingVariant: {
              select: {
                label: true,
                listing: {
                  select: {
                    customName: true,
                    frozen: true,
                    perishable: true,
                    masterProduct: { select: { name: true, imageUrl: true, category: { select: { name: true, sortOrder: true, slug: true, parent: { select: { name: true, sortOrder: true, slug: true } } } } } },
                  },
                },
              },
            },
          },
        },
      },
    });
  });
  if (!orders) return null;

  const list = buildBatchPickList(
    orders.map((order) => ({
      id: order.id,
      number: order.number,
      createdAt: order.createdAt,
      status: order.status,
      fulfillment: order.fulfillment,
      lines: order.lines.map((line) => {
        const listing = line.listingVariant.listing;
        return {
          id: line.id,
          listingVariantId: line.listingVariantId,
          qtyOrdered: line.qtyOrdered,
          qtyPicked: line.qtyPicked,
          status: line.status,
          swapRule: line.swapRule,
          substituteName: line.substituteVariant ? variantName(line.substituteVariant) : null,
          name: listing.customName ?? listing.masterProduct?.name ?? "Unknown product",
          label: line.listingVariant.label,
          imageUrl: listingImage(listing) ?? null,
          frozen: listing.frozen,
          perishable: listing.perishable,
          // A subcategory picks in its aisle's zone (#861).
          zone: listing.masterProduct?.category?.parent ?? listing.masterProduct?.category ?? null,
        };
      }),
    })),
  );
  const byId = new Map(orders.map((order) => [order.id, order]));
  return {
    batchId,
    packingStarted: !orders.some((order) => order.status === "ACCEPTED"),
    zones: list.zones,
    totes: list.totes.map((tote) => {
      const order = byId.get(tote.orderId)!;
      return {
        ...tote,
        readyEstimateAt: order.readyEstimateAt,
        canMarkReady:
          order.status === "PICKING" &&
          order.lines.every((line) => RESOLVED_LINE_STATUSES.includes(line.status as OrderLineStatus)),
      };
    }),
  };
}

/**
 * "Start packing": every Accepted order in the batch moves to Picking with its start time, and a
 * courier order books its courier for the estimated ready time (#562). A second tap does nothing.
 */
export async function startBatchPacking(storeId: string, batchId: string): Promise<Result> {
  const result = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    if (!(await openBatch(tx, batchId))) return { ok: false as const, error: BATCH_NOT_FOUND };
    const accepted = await tx.order.findMany({
      where: { pickBatchId: batchId, status: "ACCEPTED" },
      select: { id: true, fulfillment: true },
    });
    const now = new Date();
    await tx.order.updateMany({
      where: { id: { in: accepted.map((order) => order.id) }, status: "ACCEPTED" },
      data: { status: "PICKING", pickingStartedAt: now },
    });
    const effects: PickEffects[] = accepted.map((order) => ({ orderId: order.id, packing: order.fulfillment === "courier" }));
    return { ok: true as const, effects };
  });
  if (!result.ok) return result;
  runPickEffects(storeId, result.effects);
  return { ok: true };
}

/**
 * One combined line picked: the units found fill the oldest order first, so a short lands on the
 * newest. Each order line short is marked through the #13 flow and gets its own prompt.
 */
export async function pickBatchLine(
  storeId: string,
  batchId: string,
  listingVariantId: string,
  unitsFound: number,
): Promise<Result> {
  const result = await storeScopedTransaction(storeId, async (tx): Promise<{ ok: true; effects: PickEffects[] } | { ok: false; error: string }> => {
    await lockStoreRow(tx, storeId);
    if (!(await openBatch(tx, batchId))) return { ok: false, error: BATCH_NOT_FOUND };
    const orders = byOrderAge(
      await tx.order.findMany({ where: { pickBatchId: batchId, status: { in: PICKABLE_STATUSES } } }),
    );
    const lines = await tx.orderLine.findMany({
      where: { orderId: { in: orders.map((order) => order.id) }, listingVariantId, status: "pending" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const rank = new Map(orders.map((order, index) => [order.id, index]));
    lines.sort((a, b) => rank.get(a.orderId)! - rank.get(b.orderId)!);
    if (lines.length === 0) return { ok: false, error: BATCH_LINE_DONE };
    const total = lines.reduce((sum, line) => sum + line.qtyOrdered, 0);
    if (!Number.isInteger(unitsFound) || unitsFound < 0 || unitsFound > total) {
      return { ok: false, error: `${UNITS_FOUND_PREFIX}${total}` };
    }

    const effects: PickEffects[] = [];
    for (const { id, found } of allocateFound(lines, unitsFound)) {
      const line = lines.find((row) => row.id === id)!;
      // Re-read: an earlier line of the same order may have moved its status.
      const order = await tx.order.findUniqueOrThrow({ where: { id: line.orderId } });
      const done = found === line.qtyOrdered
        ? await pickLineInTx(tx, line, order)
        : await shortLineInTx(tx, storeId, line, order, found);
      effects.push(done.effects);
    }
    return { ok: true, effects };
  }, LEDGER_TRANSACTION);
  if (!result.ok) return result;
  runPickEffects(storeId, result.effects);
  return { ok: true };
}

/** Leaving (or finishing) a batch: each order goes back to normal picking with its lines as they are. */
export async function leaveBatch(storeId: string, batchId: string): Promise<Result> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    if (!(await openBatch(tx, batchId))) return { ok: false as const, error: BATCH_NOT_FOUND };
    await tx.order.updateMany({ where: { pickBatchId: batchId }, data: { pickBatchId: null } });
    await tx.pickBatch.update({ where: { id: batchId }, data: { closedAt: new Date() } });
    return { ok: true as const };
  });
}
