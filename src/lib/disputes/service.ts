import { platform, platformAdminTransaction } from "../db";
import { emailPlatformAdmins } from "../email/platform-admins";
import { escapeHtml } from "../format";
import { pushToStoreMembers } from "../push/store-members";
import type { WebhookEvent } from "../stripe/types";
import { isClosedDisputeStatus } from "./status";

const DISPUTE_EVENT_TYPES = new Set([
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
]);

export function isDisputeEvent(event: Pick<WebhookEvent, "type" | "dispute">): boolean {
  return DISPUTE_EVENT_TYPES.has(event.type) && Boolean(event.dispute);
}

export type DisputeEventResult = "applied" | "replayed" | "stale" | "ignored";

type Notice = { id: string; storeId: string | null; orderId: string | null; stripeDisputeId: string; amountCents: number; currency: string };

/**
 * Stripe's charge.dispute.* webhooks are the only writer of disputes. Idempotent by event id; an event older than the
 * newest one applied is recorded and skipped. The platform absorbs a lost dispute in v1, so no money moves here: the
 * order, its capture and the store's transfer are left as they are.
 */
export async function applyDisputeEvent(event: WebhookEvent): Promise<DisputeEventResult> {
  if (!isDisputeEvent(event) || !event.eventId) return "ignored";
  const d = event.dispute!;
  const eventId = event.eventId;
  const created = new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000);

  const outcome = await platformAdminTransaction(async (tx) => {
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO payment_dispute_events (id, stripe_dispute_id, type)
      VALUES (${eventId}, ${d.id}, ${event.type})
      ON CONFLICT (id) DO NOTHING
      RETURNING id`;
    await tx.$queryRaw`SELECT id FROM payment_disputes WHERE stripe_dispute_id = ${d.id} FOR UPDATE`;
    const existing = await tx.paymentDispute.findUnique({ where: { stripeDisputeId: d.id } });
    // A replay still tells whoever a crashed run did not.
    if (claimed.length === 0) return { result: "replayed" as const, row: existing };

    const fields = {
      chargeId: d.chargeId,
      paymentIntentId: d.paymentIntentId,
      amountCents: d.amountCents,
      currency: d.currency,
      reason: d.reason,
      status: d.status,
      evidenceDueBy: d.evidenceDueBy === null ? null : new Date(d.evidenceDueBy * 1000),
      outcome: isClosedDisputeStatus(d.status) ? d.status : null,
      feeCents: d.feeCents,
      livemode: d.livemode,
      lastEventAt: created,
    };

    if (!existing) {
      const order = d.paymentIntentId
        ? await tx.order.findUnique({ where: { paymentIntentId: d.paymentIntentId }, select: { id: true, storeId: true } })
        : null;
      const row = await tx.paymentDispute.create({
        data: { ...fields, stripeDisputeId: d.id, storeId: order?.storeId ?? null, orderId: order?.id ?? null },
      });
      return { result: "applied" as const, row };
    }

    if (created < existing.lastEventAt) return { result: "stale" as const, row: existing };
    // Stripe's `created` is whole seconds: on a tie, a closed dispute is never reopened.
    if (created.getTime() === existing.lastEventAt.getTime() && isClosedDisputeStatus(existing.status) && !isClosedDisputeStatus(d.status)) {
      return { result: "stale" as const, row: existing };
    }
    const row = await tx.paymentDispute.update({ where: { id: existing.id }, data: fields });
    return { result: "applied" as const, row };
  });

  if (outcome.row && !outcome.row.notifiedAt) await notify(outcome.row);
  return outcome.result;
}

/** Owners get one push per dispute; a dispute with no order goes to every platform admin instead. */
async function notify(dispute: Notice): Promise<void> {
  if (dispute.storeId && dispute.orderId) {
    const [order, store] = await Promise.all([
      platformAdminTransaction((tx) => tx.order.findUnique({ where: { id: dispute.orderId! }, select: { number: true } })),
      platform.store.findUnique({ where: { id: dispute.storeId }, select: { slug: true } }),
    ]);
    if (order && store) {
      await pushToStoreMembers(dispute.storeId, {
        title: "Card dispute",
        body: `A customer disputed order #${order.number}`,
        url: `/store-admin/orders?store=${encodeURIComponent(store.slug)}`,
        tag: `dispute-${dispute.id}`,
      }, process.env, { roles: ["owner"] });
    }
  } else {
    console.error(JSON.stringify({ event: "payment_dispute_unmatched", stripeDisputeId: dispute.stripeDisputeId }));
    const amount = `${(dispute.amountCents / 100).toFixed(2)} ${dispute.currency.toUpperCase()}`;
    await emailPlatformAdmins(
      "Card dispute with no matching order",
      `<p>Stripe opened dispute <code>${escapeHtml(dispute.stripeDisputeId)}</code> for ${escapeHtml(amount)} on a charge that matches no order. It is on the Disputes page in the admin console; answer it in the Stripe Dashboard.</p>`,
      `dispute-unmatched-${dispute.stripeDisputeId}`,
    );
  }
  await platformAdminTransaction((tx) => tx.paymentDispute.update({ where: { id: dispute.id }, data: { notifiedAt: new Date() } }));
}
