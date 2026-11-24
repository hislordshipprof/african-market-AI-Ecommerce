import { isWhatsAppOptedOut, NOTIFICATION_EXPIRE_MS, NOTIFICATION_REPLAY_MS, storeScoped, storeScopedTransaction } from "../db";
import { storeWhatsAppSender } from "../whatsapp/store-number";
import { normalizeUsPhone } from "./phone";
import { orderTrackingUrl } from "./tracking-url";
import { notificationChannels, type NotificationChannel } from "./channels";
import type { NotifyOrder } from "./messages";
import { isOrderNotifyEvent, type OrderNotifyEvent } from "./record";

const RANK: Record<OrderNotifyEvent, number> = {
  placed: 0,
  accepted: 1,
  ready: 2,
  out_for_delivery: 3,
  // A parcel's two steps on the way (#568): the same step, so the customer hears both.
  shipped: 3,
  in_transit: 3,
  // A store-delivery order ends at delivered, a pickup order at completed: same step, so neither supersedes the other.
  delivered: 4,
  completed: 4,
  cancelled: 5,
  refunded: 6,
  // Not status steps: they never supersede one. skipReason never skips a reply.
  store_replied: -1,
  substitution: -1,
};
const CANCEL_STATUSES = new Set(["CANCELLING", "CANCELLED", "REFUND_FAILED"]);
const loggedUrl = new Set<string>();

type StepLike = {
  run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>;
};

const lineInclude = {
  listingVariant: {
    include: {
      listing: { select: { customName: true, masterProduct: { select: { name: true } } } },
    },
  },
  substituteVariant: {
    include: {
      listing: { select: { customName: true, masterProduct: { select: { name: true } } } },
    },
  },
} as const;

function log(event: string, orderId: string, channel?: string, reason?: string): void {
  console.error(JSON.stringify({
    event,
    orderId,
    ...(channel ? { channel } : {}),
    ...(reason ? { reason } : {}),
  }));
}

async function loadOrder(storeId: string, orderId: string): Promise<NotifyOrder | null> {
  const order = await loadOrderRow(storeId, orderId);
  if (!order?.whatsappOptInAt) return order;
  const phone = normalizeUsPhone(order.customer.phone);
  const [sender, optedOut] = await Promise.all([
    storeWhatsAppSender(storeId),
    phone.ok ? isWhatsAppOptedOut(storeId, phone.e164.slice(1)) : Promise.resolve(false),
  ]);
  return { ...order, whatsapp: { sender, optedOut } };
}

async function loadOrderRow(storeId: string, orderId: string) {
  return storeScopedTransaction(storeId, async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { name: true, email: true, phone: true } },
        coupon: { select: { code: true } },
        store: {
          select: {
            name: true,
            slug: true,
            logoUrl: true,
            brandColor: true,
            themePreset: true,
            timezone: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            state: true,
            zip: true,
            phone: true,
            hours: true,
          },
        },
        // A fixed order keeps a re-rendered body identical, so a retry replays its idempotency key.
        lines: { include: lineInclude, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      },
    });
    if (!order) return null;
    const manual = await tx.auditLog.findFirst({
      where: { entityId: orderId, entityType: "order", action: "refund_resolved_manually" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const after = manual?.after;
    const raw = after && typeof after === "object" && !Array.isArray(after)
      ? after as Record<string, unknown>
      : null;
    return {
      ...order,
      customer: {
        name: order.customer?.name ?? "",
        email: order.customer?.email ?? null,
        phone: order.customer?.phone ?? null,
      },
      manualResolution: raw
        ? {
            refundedCents: typeof raw.refundedCents === "number" ? raw.refundedCents : 0,
            repaidCents: typeof raw.repaidCents === "number" ? raw.repaidCents : 0,
            capturedCents: typeof raw.capturedCents === "number" ? raw.capturedCents : 0,
          }
        : null,
    };
  });
}

async function claim(
  storeId: string,
  orderId: string,
  event: string,
  channel: string,
): Promise<{ id: string; replay: boolean } | null> {
  return storeScopedTransaction(storeId, async (tx) => {
    const row = await tx.notificationLog.findUnique({
      where: { orderId_event_channel: { orderId, event, channel } },
    });
    if (!row || (row.status !== "pending" && row.status !== "sending")) return null;
    // A `sending` row may have reached the provider: replay its key rather than expire it.
    const expireMs = row.status === "pending" ? NOTIFICATION_EXPIRE_MS : NOTIFICATION_REPLAY_MS;
    if (row.createdAt.getTime() <= Date.now() - expireMs) {
      await tx.notificationLog.update({
        where: { id: row.id },
        data: { status: "failed", reason: "expired" },
      });
      return null;
    }
    const claimed = await tx.notificationLog.updateMany({
      where: { id: row.id, status: { in: ["pending", "sending"] } },
      data: { status: "sending", attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return null;
    return { id: row.id, replay: row.status === "sending" };
  });
}

async function writeResult(
  storeId: string,
  rowId: string,
  status: "sent" | "skipped" | "failed",
  reason: string | null,
  providerMessageId?: string,
): Promise<void> {
  await storeScopedTransaction(storeId, async (tx) => {
    await tx.notificationLog.update({
      where: { id: rowId },
      data: {
        status,
        reason,
        ...(providerMessageId ? { providerMessageId } : {}),
        ...(status === "sent" ? { sentAt: new Date() } : {}),
      },
    });
  });
}

/** WhatsApp and SMS are one phone channel: a later step sent on either supersedes this one. */
function sameChannel(channel: string): string[] {
  return channel === "sms" || channel === "whatsapp" ? ["sms", "whatsapp"] : [channel];
}

async function whatsappSent(storeId: string, orderId: string, event: OrderNotifyEvent): Promise<boolean> {
  const row = await storeScoped(storeId).notificationLog.findUnique({
    where: { orderId_event_channel: { orderId, event, channel: "whatsapp" } },
    select: { status: true },
  });
  return row?.status === "sent";
}

async function higherSent(
  storeId: string,
  orderId: string,
  event: OrderNotifyEvent,
  channel: string,
): Promise<boolean> {
  const rows = await storeScoped(storeId).notificationLog.findMany({
    where: { orderId, channel: { in: sameChannel(channel) }, status: "sent" },
    select: { event: true },
  });
  return rows.some((row) => (RANK[row.event as OrderNotifyEvent] ?? -1) > RANK[event]);
}

function skipReason(event: OrderNotifyEvent, status: string, blockedByLater: boolean): string | null {
  if (event === "store_replied") return null;
  // A prompt is only worth sending while the order still waits for the answer.
  if (event === "substitution") return status === "SUBSTITUTION_PENDING" ? null : "superseded";
  if (event !== "cancelled" && CANCEL_STATUSES.has(status)) return "superseded";
  if (event !== "placed" && blockedByLater) return "superseded";
  return null;
}

async function runChannel(
  channel: NotificationChannel,
  order: NotifyOrder,
  event: OrderNotifyEvent,
  storeId: string,
  env: Record<string, string | undefined>,
): Promise<{ status: string; reason: string | null }> {
  const claimed = await claim(storeId, order.id, event, channel.kind);
  if (!claimed) return { status: "unchanged", reason: null };
  // No idempotency key on a WhatsApp send: an attempt that may have reached Meta is not repeated; SMS covers it.
  if (channel.kind === "whatsapp" && claimed.replay) {
    await writeResult(storeId, claimed.id, "failed", "outcome_unknown");
    return { status: "failed", reason: "outcome_unknown" };
  }
  const url = order.trackingToken
    ? orderTrackingUrl(order.store, order.trackingToken, env, event === "substitution" ? "/substitutions" : "")
    : null;
  if (!url) {
    if (!loggedUrl.has("tracking_url_unavailable")) {
      loggedUrl.add("tracking_url_unavailable");
      log("tracking_url_unavailable", order.id, channel.kind, "tracking_url_unavailable");
    }
    await writeResult(storeId, claimed.id, "skipped", "tracking_url_unavailable");
    return { status: "skipped", reason: "tracking_url_unavailable" };
  }
  const blocked = await higherSent(storeId, order.id, event, channel.kind);
  const skip = skipReason(event, order.status, blocked);
  if (skip) {
    await writeResult(storeId, claimed.id, "skipped", skip);
    return { status: "skipped", reason: skip };
  }
  // WhatsApp replaces SMS for an opted-in customer; SMS goes only when WhatsApp did not (#560).
  if (channel.kind === "sms" && await whatsappSent(storeId, order.id, event)) {
    await writeResult(storeId, claimed.id, "skipped", "whatsapp_sent");
    return { status: "skipped", reason: "whatsapp_sent" };
  }
  const prepared = channel.prepare(order, event, url, env);
  if (prepared.outcome !== "ready") {
    await writeResult(storeId, claimed.id, prepared.outcome, prepared.reason);
    return { status: prepared.outcome, reason: prepared.reason };
  }
  const result = await channel.send(prepared.message, { idempotencyKey: `notif_${claimed.id}` }, env);
  await writeResult(
    storeId,
    claimed.id,
    result.outcome === "sent" ? "sent" : result.outcome,
    result.outcome === "sent" ? null : result.reason,
    result.outcome === "sent" ? result.providerMessageId : undefined,
  );
  return { status: result.outcome, reason: result.outcome === "sent" ? null : result.reason };
}

/** Fails the rows still open for an event: one channel's, or every channel's. */
async function markRetriesExhausted(storeId: string, orderId: string, event: string, channel?: string): Promise<void> {
  await storeScopedTransaction(storeId, async (tx) => {
    await tx.notificationLog.updateMany({
      where: { orderId, event, ...(channel ? { channel } : {}), status: { in: ["pending", "sending"] } },
      data: { status: "failed", reason: "retries_exhausted" },
    });
  });
}

export async function deliverOrderNotification(
  data: { storeId?: string; orderId?: string; event?: string },
  step: StepLike,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const storeId = data.storeId ?? "";
  const orderId = data.orderId ?? "";
  const eventName = data.event ?? "";
  if (!storeId || !orderId || !isOrderNotifyEvent(eventName)) return;

  const order = await loadOrder(storeId, orderId);
  if (!order) {
    log("notification_order_not_found", orderId);
    return;
  }
  const existing = await storeScoped(storeId).notificationLog.count({
    where: { orderId, event: eventName },
  });
  if (existing === 0) {
    log("notification_rows_missing", orderId, undefined, eventName);
    return;
  }

  for (const channel of notificationChannels) {
    try {
      await step.run(channel.kind, () => runChannel(channel, order, eventName, storeId, env));
    } catch {
      log("notification_step_failed", orderId, channel.kind, "retries_exhausted");
      await markRetriesExhausted(storeId, orderId, eventName, channel.kind);
    }
  }
}

/** Backstop when the run fails before a channel step finishes. Idempotent. */
export async function onNotificationFailure(event: {
  data?: { event?: { data?: { storeId?: string; orderId?: string; event?: string } } };
}): Promise<void> {
  const data = event.data?.event?.data;
  if (!data?.storeId || !data.orderId || !data.event) return;
  await markRetriesExhausted(data.storeId, data.orderId, data.event);
}
