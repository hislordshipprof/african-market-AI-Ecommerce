import { storeScoped, storeScopedTransaction } from "../db";
import { orderTrackingUrl } from "./tracking-url";
import { notificationChannels, type NotificationChannel } from "./channels";
import type { NotifyOrder } from "./messages";
import { isOrderNotifyEvent, type OrderNotifyEvent } from "./record";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const RANK: Record<OrderNotifyEvent, number> = {
  placed: 0,
  accepted: 1,
  ready: 2,
  out_for_delivery: 3,
  // A store-delivery order ends at delivered, a pickup order at completed: same step, so neither supersedes the other.
  delivered: 4,
  completed: 4,
  cancelled: 5,
  refunded: 6,
  // Not a status step: it never supersedes one, and skipReason never skips it.
  store_replied: -1,
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
  return storeScopedTransaction(storeId, async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { name: true, email: true, phone: true } },
        store: {
          select: {
            name: true,
            slug: true,
            logoUrl: true,
            brandColor: true,
            themePreset: true,
            timezone: true,
          },
        },
        lines: { include: lineInclude },
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
): Promise<{ id: string } | null> {
  return storeScopedTransaction(storeId, async (tx) => {
    const row = await tx.notificationLog.findUnique({
      where: { orderId_event_channel: { orderId, event, channel } },
    });
    if (!row || (row.status !== "pending" && row.status !== "sending")) return null;
    if (row.createdAt.getTime() <= Date.now() - TWO_HOURS_MS) {
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
    return { id: row.id };
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

async function higherSent(
  storeId: string,
  orderId: string,
  event: OrderNotifyEvent,
  channel: string,
): Promise<boolean> {
  const rows = await storeScoped(storeId).notificationLog.findMany({
    where: { orderId, channel, status: "sent" },
    select: { event: true },
  });
  return rows.some((row) => (RANK[row.event as OrderNotifyEvent] ?? -1) > RANK[event]);
}

function skipReason(event: OrderNotifyEvent, status: string, blockedByLater: boolean): string | null {
  if (event === "store_replied") return null;
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
  const url = order.trackingToken
    ? orderTrackingUrl(order.store, order.trackingToken, env)
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
  const prepared = channel.prepare(order, event, url, env);
  if (prepared.outcome !== "ready") {
    if (prepared.outcome === "sent") {
      await writeResult(storeId, claimed.id, "sent", null, prepared.providerMessageId);
      return { status: "sent", reason: null };
    }
    await writeResult(storeId, claimed.id, prepared.outcome, prepared.reason);
    return { status: prepared.outcome, reason: prepared.reason };
  }
  const result = await channel.send(prepared.message, { idempotencyKey: `notif_${claimed.id}` });
  await writeResult(
    storeId,
    claimed.id,
    result.outcome === "sent" ? "sent" : result.outcome,
    result.outcome === "sent" ? null : result.reason,
    result.outcome === "sent" ? result.providerMessageId : undefined,
  );
  return { status: result.outcome, reason: result.outcome === "sent" ? null : result.reason };
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
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.notificationLog.updateMany({
          where: {
            orderId,
            event: eventName,
            channel: channel.kind,
            status: { in: ["pending", "sending"] },
          },
          data: { status: "failed", reason: "retries_exhausted" },
        });
      });
    }
  }
}

/** Backstop when the run fails before a channel step finishes. Idempotent. */
export async function onNotificationFailure(event: {
  data?: { event?: { data?: { storeId?: string; orderId?: string; event?: string } } };
}): Promise<void> {
  const data = event.data?.event?.data;
  if (!data?.storeId || !data.orderId || !data.event) return;
  await storeScopedTransaction(data.storeId, async (tx) => {
    await tx.notificationLog.updateMany({
      where: {
        orderId: data.orderId,
        event: data.event,
        status: { in: ["pending", "sending"] },
      },
      data: { status: "failed", reason: "retries_exhausted" },
    });
  });
}
