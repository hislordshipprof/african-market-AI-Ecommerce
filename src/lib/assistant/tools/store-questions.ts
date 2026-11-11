import { createHash } from "node:crypto";
import { revalidateTag } from "next/cache";
import { confirmDeliveryAddress } from "../../address/confirm";
import { platform, storeScoped } from "../../db";
import { isStoreOpen, isValidTimezone } from "../../order/store-hours";
import { takeRateLimit } from "../../rate-limit/app-limiter";
import {
  announceCustomerMessage,
  MESSAGE_MAX_CHARS,
  messageBodySchema,
  orderMessagesTag,
  postCustomerMessageForOrder,
} from "../../support/thread";
import { recordRead, type AssistantContext, type ToolResult } from "./execute";
import {
  checkDeliveryAreaInput,
  forwardToStoreInput,
  getOrderStatusInput,
  getStoreInfoInput,
  parseToolInput,
} from "./schemas";

const MESSAGES: Record<string, string> = {
  sign_in_required: "Sign in to see your orders or to message the store about one.",
  no_orders: "You have no orders at this store yet.",
  order_not_found: "No order with that number on your account at this store.",
  store_not_found: "This store is not available.",
  street_required: "Give a street address with the city, state and ZIP so the store can check it.",
  no_store_location: "This store has not set its address yet, so delivery cannot be checked.",
  forward_failed: "The message could not be sent to the store. Try again.",
  rate_limited: "Too many messages to the store about this order. Please wait and try again.",
};

function fail(code: string, message?: string): ToolResult {
  return { ok: false, code, message: message ?? MESSAGES[code] ?? "That did not work." };
}

const ORDER_LIMIT = 5;
const ISSUE_MAX_CHARS = 600;
// The same per-order budget as the customer's own messages (support/customer-actions.ts).
const MESSAGES_PER_ORDER_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

/** The latest timestamp the order carries, as its last event. */
function lastEvent(order: {
  createdAt: Date;
  acceptedAt: Date | null;
  readyAt: Date | null;
  outForDeliveryAt: Date | null;
  deliveredAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
}): { type: string; at: string } {
  const events: Array<[string, Date | null]> = [
    ["placed", order.createdAt],
    ["accepted", order.acceptedAt],
    ["ready", order.readyAt],
    ["out_for_delivery", order.outForDeliveryAt],
    ["delivered", order.deliveredAt],
    ["completed", order.completedAt],
    ["cancelled", order.cancelledAt],
  ];
  let latest: [string, Date] = ["placed", order.createdAt];
  for (const [type, at] of events) {
    if (at && at.getTime() >= latest[1].getTime()) latest = [type, at];
  }
  return { type: latest[0], at: latest[1].toISOString() };
}

/**
 * The signed-in customer's orders here: those on the account Customer and on guest rows it claimed,
 * the same rule as the account page. RLS gates only the store, so the customer filter is the auth check.
 */
async function ownOrders(ctx: AssistantContext, orderNumber: number | undefined) {
  if (!ctx.actorUserId) return { ok: false, code: "sign_in_required" } as const;
  const scoped = storeScoped(ctx.storeId);
  const account = await scoped.customer.findFirst({ where: { userId: ctx.actorUserId }, select: { id: true } });
  if (!account) return { ok: false, code: orderNumber === undefined ? "no_orders" : "order_not_found" } as const;
  const orders = await scoped.order.findMany({
    where: {
      storeId: ctx.storeId,
      OR: [{ customerId: account.id }, { customer: { storeId: ctx.storeId, claimedByCustomerId: account.id } }],
      ...(orderNumber !== undefined ? { number: orderNumber } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { number: "desc" }],
    take: ORDER_LIMIT,
    select: {
      id: true,
      number: true,
      status: true,
      fulfillment: true,
      createdAt: true,
      acceptedAt: true,
      readyAt: true,
      outForDeliveryAt: true,
      deliveredAt: true,
      completedAt: true,
      cancelledAt: true,
      prepEstimateMinutes: true,
      // For the hand-off's cache tag only; never in a tool output.
      trackingToken: true,
      lines: {
        orderBy: { createdAt: "asc" },
        select: {
          qtyOrdered: true,
          listingVariant: {
            select: { label: true, listing: { select: { customName: true, masterProduct: { select: { name: true } } } } },
          },
        },
      },
    },
  });
  if (orders.length === 0) return { ok: false, code: orderNumber === undefined ? "no_orders" : "order_not_found" } as const;
  return { ok: true, orders } as const;
}

type OwnOrder = Extract<Awaited<ReturnType<typeof ownOrders>>, { ok: true }>["orders"][number];

function lineSummary(order: OwnOrder) {
  return order.lines.map((line) => {
    const listing = line.listingVariant.listing;
    return {
      name: listing.customName || listing.masterProduct?.name || "Unnamed",
      packLabel: line.listingVariant.label,
      qty: line.qtyOrdered,
    };
  });
}

export async function getOrderStatus(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(getOrderStatusInput, input);
  const found = await ownOrders(ctx, parsed.order_number);
  if (!found.ok) return recordRead(ctx, "get_order_status", parsed, fail(found.code));
  const orders = found.orders.map((order) => ({
    number: order.number,
    status: order.status,
    fulfillment: order.fulfillment,
    placedAt: order.createdAt.toISOString(),
    ...(order.prepEstimateMinutes != null ? { prepEstimateMinutes: order.prepEstimateMinutes } : {}),
    lines: lineSummary(order),
    lastEvent: lastEvent(order),
  }));
  return recordRead(ctx, "get_order_status", parsed, { ok: true, orders });
}

export async function checkDeliveryArea(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(checkDeliveryAreaInput, input);
  const store = await platform.store.findUnique({
    where: { id: ctx.storeId },
    select: {
      lat: true,
      lng: true,
      deliveryRadiusMi: true,
      storeDeliveryEnabled: true,
      storeDeliveryFeeCents: true,
      pickupEnabled: true,
    },
  });
  if (!store) return recordRead(ctx, "check_delivery_area", parsed, fail("store_not_found"));
  const { line1, city, state, zip } = parsed;
  // The address service geocodes street addresses only; a ZIP alone cannot be placed.
  if (!line1 || !city || !state) return recordRead(ctx, "check_delivery_area", parsed, fail("street_required"));
  if (store.lat == null || store.lng == null) {
    return recordRead(ctx, "check_delivery_area", parsed, fail("no_store_location"));
  }
  const radiusMi = Number(store.deliveryRadiusMi);
  const decision = await confirmDeliveryAddress(
    { line1, city, state, zip },
    { lat: store.lat, lng: store.lng, radiusMi },
    { limit: true, ip: `assistant:${ctx.cartId}` },
  );
  if (!decision.ok) {
    return recordRead(ctx, "check_delivery_area", parsed, fail(decision.code, decision.message));
  }
  const storeDelivery = store.storeDeliveryEnabled && radiusMi > 0 && decision.withinRadius;
  return recordRead(ctx, "check_delivery_area", parsed, {
    ok: true,
    address: decision.match.formattedAddress,
    distanceMi: decision.roundedMi,
    radiusMi,
    withinRadius: decision.withinRadius,
    storeDelivery,
    ...(storeDelivery ? { storeDeliveryFeeCents: store.storeDeliveryFeeCents } : {}),
    // Checkout refuses courier delivery in Phase 1.
    courier: false,
    pickup: store.pickupEnabled,
  });
}

function weekdayIn(timezone: string, now: Date): string {
  const zone = isValidTimezone(timezone) ? timezone : "America/New_York";
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(now).toLowerCase();
}

export async function getStoreInfo(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(getStoreInfoInput, input);
  const store = await platform.store.findUnique({
    where: { id: ctx.storeId },
    select: {
      name: true,
      hours: true,
      timezone: true,
      minimumOrderCents: true,
      pickupEnabled: true,
      deliveryInfo: true,
      storeDeliveryEnabled: true,
      storeDeliveryFeeCents: true,
      deliveryRadiusMi: true,
      ownerName: true,
      ownerStory: true,
      neighborhood: true,
    },
  });
  if (!store) return recordRead(ctx, "get_store_info", parsed, fail("store_not_found"));
  const now = new Date();
  return recordRead(ctx, "get_store_info", parsed, {
    ok: true,
    name: store.name,
    hours: store.hours ?? null,
    timezone: store.timezone,
    today: weekdayIn(store.timezone, now),
    openNow: isStoreOpen(store.hours, store.timezone, now),
    minimumOrderCents: store.minimumOrderCents,
    pickup: store.pickupEnabled,
    deliveryInfo: store.deliveryInfo,
    storeDelivery: {
      enabled: store.storeDeliveryEnabled,
      feeCents: store.storeDeliveryFeeCents,
      radiusMi: Number(store.deliveryRadiusMi),
    },
    ownerName: store.ownerName,
    ownerStory: store.ownerStory,
    neighborhood: store.neighborhood,
  });
}

/** The header and the customer's words stay whole; the item list is cut to fit the message limit. */
function forwardBody(order: OwnOrder, issue: string): string {
  const header = `Order #${order.number} (${order.status}). Sent by the shopper assistant for the customer.`;
  const says = `Customer says: ${issue.slice(0, ISSUE_MAX_CHARS)}`;
  const items = lineSummary(order).map((line) => `${line.qty} × ${line.name} (${line.packLabel})`);
  const budget = MESSAGE_MAX_CHARS - header.length - says.length - 2;
  let shown = items.length;
  const itemLine = () => {
    const more = items.length - shown;
    return `Items: ${items.slice(0, shown).join(", ")}${more > 0 ? `${shown > 0 ? ", " : ""}…and ${more} more` : ""}`;
  };
  while (shown > 0 && itemLine().length > budget) shown--;
  const list = items.length > 0 && itemLine().length <= budget ? itemLine() : "";
  return [header, list, says].filter(Boolean).join("\n");
}

/**
 * Complaints and refund requests go to the order's support thread; the assistant never resolves them.
 * Without an order number the customer's newest order here is used.
 */
export async function forwardToStore(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(forwardToStoreInput, input);
  const found = await ownOrders(ctx, parsed.order_number);
  if (!found.ok) return recordRead(ctx, "forward_to_store", parsed, fail(found.code));
  const order = found.orders[0];
  const body = messageBodySchema.safeParse(forwardBody(order, parsed.issue));
  if (!body.success) return recordRead(ctx, "forward_to_store", parsed, fail("forward_failed"));
  const store = await platform.store.findUnique({ where: { id: ctx.storeId }, select: { id: true, slug: true } });
  if (!store) return recordRead(ctx, "forward_to_store", parsed, fail("store_not_found"));
  const limitKey = order.trackingToken
    ? `support-message:token:${createHash("sha256").update(order.trackingToken).digest("hex").slice(0, 32)}`
    : `support-message:order:${order.id}`;
  const limit = await takeRateLimit(limitKey, MESSAGES_PER_ORDER_PER_HOUR, HOUR_MS);
  if (!limit.ok) return recordRead(ctx, "forward_to_store", parsed, fail("rate_limited"));
  const posted = await postCustomerMessageForOrder(ctx.storeId, order.id, body.data);
  if (!posted) return recordRead(ctx, "forward_to_store", parsed, fail("forward_failed"));
  if (order.trackingToken) revalidateTag(orderMessagesTag(order.trackingToken), { expire: 0 });
  announceCustomerMessage(store, posted, body.data);
  const result: ToolResult = {
    ok: true,
    forwarded: true,
    orderNumber: posted.orderNumber,
    continueIn: "The order's messages on the order tracking page or the account page.",
  };
  // The store already has the message; reporting an audit failure would invite a duplicate retry.
  const recorded = await recordRead(ctx, "forward_to_store", parsed, result);
  return recorded.ok ? recorded : result;
}
