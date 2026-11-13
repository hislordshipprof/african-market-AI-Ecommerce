import { Prisma } from "@prisma/client";
import {
  authPrisma,
  claimStripeBillingEvent,
  lockPilotOffer,
  lockStoreSubscriptionRow,
  platformAdmin,
  platformAdminTransaction,
  storeScoped,
} from "../db";
import { sendEmail } from "../email/send";
import { SYSTEM_ACTOR_EMAIL, SYSTEM_ACTOR_ID } from "../system-actor";
import type { WebhookEvent } from "../stripe/types";
import { effectivePlan, type Plan } from "./plan";
import { getBillingProvider, planForLookupKey } from "./provider";

export const PILOT_STORE_CAP = 5;
export const PILOT_FREE_MONTHS = 3;

export interface Actor {
  id: string;
  email: string;
}

export type StoreBilling = Awaited<ReturnType<typeof getStoreBilling>>;

/** The store's own billing row, read under its RLS context. */
export async function getStoreBilling(storeId: string) {
  const row = await storeScoped(storeId).storeSubscription.findUnique({ where: { storeId } });
  return {
    plan: effectivePlan(row),
    chosenPlan: (row?.plan ?? "starter") as Plan,
    status: row?.status ?? "none",
    pilot: row?.pilot ?? false,
    trialEndsAt: row?.trialEndsAt ?? null,
    currentPeriodEnd: row?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    paymentFailedAt: row?.paymentFailedAt ?? null,
    hasCustomer: Boolean(row?.stripeCustomerId),
    subscribed: Boolean(row?.stripeSubscriptionId) && row?.status !== "canceled",
  };
}

export function pilotTrialEnd(from: Date): Date {
  const end = new Date(from);
  end.setUTCMonth(end.getUTCMonth() + PILOT_FREE_MONTHS);
  return end;
}

type Tx = Parameters<Parameters<typeof platformAdminTransaction>[0]>[0];

async function lockedRow(tx: Tx, storeId: string) {
  await lockStoreSubscriptionRow(tx, storeId);
  return tx.storeSubscription.findUniqueOrThrow({ where: { storeId } });
}

/** Owner picks a plan: a hosted Checkout for a new subscription, the Customer Portal once subscribed. */
export async function startSubscription(input: {
  storeId: string;
  storeName: string;
  plan: Plan;
  owner: Actor;
  returnUrl: string;
  now?: Date;
}): Promise<{ url: string }> {
  const provider = getBillingProvider();
  const now = input.now ?? new Date();
  const row = await platformAdminTransaction((tx) => lockedRow(tx, input.storeId));
  let customerId = row.stripeCustomerId;
  if (!customerId) {
    customerId = await provider.createCustomer({ storeId: input.storeId, name: input.storeName, email: input.owner.email });
    await platformAdmin.storeSubscription.update({
      where: { storeId: input.storeId },
      data: { stripeCustomerId: customerId },
    });
  }
  if (row.stripeSubscriptionId && row.status !== "canceled") {
    return provider.createPortalSession({ customerId, returnUrl: input.returnUrl });
  }
  // The pilot's free months run from the first subscription; a store that already had one pays from day one.
  const trialEnd = row.pilot && !row.stripeSubscriptionId ? Math.floor(pilotTrialEnd(now).getTime() / 1000) : null;
  return provider.createCheckoutSession({
    customerId,
    plan: input.plan,
    storeId: input.storeId,
    trialEnd,
    successUrl: input.returnUrl,
    cancelUrl: input.returnUrl,
  });
}

export async function openBillingPortal(storeId: string, returnUrl: string): Promise<{ url: string } | null> {
  const row = await storeScoped(storeId).storeSubscription.findUnique({ where: { storeId } });
  if (!row?.stripeCustomerId) return null;
  return getBillingProvider().createPortalSession({ customerId: row.stripeCustomerId, returnUrl });
}

/** Platform admin grants or removes the pilot offer. At most PILOT_STORE_CAP pilot stores. */
export async function setPilot(
  storeId: string,
  pilot: boolean,
  actor: Actor,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await platformAdminTransaction(async (tx) => {
    await lockPilotOffer(tx);
    const row = await lockedRow(tx, storeId);
    if (row.pilot === pilot) return { ok: true as const, row, changed: false };
    if (pilot) {
      const count = await tx.storeSubscription.count({ where: { pilot: true } });
      if (count >= PILOT_STORE_CAP) {
        return { ok: false as const, error: `The pilot offer is limited to ${PILOT_STORE_CAP} stores.` };
      }
    }
    await tx.storeSubscription.update({ where: { storeId }, data: { pilot } });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: pilot ? "subscription.pilot_granted" : "subscription.pilot_removed",
        entityType: "store_subscription",
        entityId: storeId,
        before: { pilot: row.pilot },
        after: { pilot },
      },
    });
    return { ok: true as const, row, changed: true };
  });
  if (!result.ok) return result;
  const { row, changed } = result;
  // Granted after subscribing: move the live subscription's first charge past the free months.
  if (changed && pilot && row.stripeSubscriptionId && row.status !== "canceled") {
    await getBillingProvider().setTrialEnd(row.stripeSubscriptionId, Math.floor(pilotTrialEnd(now).getTime() / 1000));
  }
  return { ok: true };
}

const BILLING_EVENT_TYPES = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

export function isBillingEvent(event: Pick<WebhookEvent, "type">): boolean {
  return BILLING_EVENT_TYPES.has(event.type);
}

export type BillingEventResult = "applied" | "replayed" | "stale" | "unknown_store" | "ignored";

/**
 * Stripe webhooks are the only writer of billing state. Idempotent by event id;
 * an older subscription event arriving after a newer one is recorded and skipped.
 */
export async function applyBillingEvent(event: WebhookEvent): Promise<BillingEventResult> {
  if (!isBillingEvent(event) || !event.eventId) return "ignored";
  const subscription = event.subscription;
  const invoice = event.invoice;
  if (!subscription && !invoice) return "ignored";
  const eventId = event.eventId;
  const created = new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000);

  const outcome = await platformAdminTransaction(async (tx) => {
    const storeId = await resolveStore(tx, subscription, invoice);
    if (!(await claimStripeBillingEvent(tx, eventId, storeId, event.type))) return { result: "replayed" as const };
    if (!storeId) return { result: "unknown_store" as const };

    const row = await lockedRow(tx, storeId);
    const before = { plan: row.plan, status: row.status, paymentFailedAt: row.paymentFailedAt?.toISOString() ?? null };

    if (subscription) {
      if (row.lastEventAt && created < row.lastEventAt) return { result: "stale" as const };
      if (row.stripeSubscriptionId && row.stripeSubscriptionId !== subscription.id && row.status !== "canceled" && event.type !== "customer.subscription.created") {
        // An event for a subscription the store has since replaced.
        return { result: "stale" as const };
      }
      const plan = planForLookupKey(subscription.lookupKey) ?? (row.plan as Plan);
      const status = event.type === "customer.subscription.deleted" ? "canceled" : subscription.status;
      const updated = await tx.storeSubscription.update({
        where: { storeId },
        data: {
          plan,
          status,
          stripeSubscriptionId: subscription.id,
          stripeCustomerId: row.stripeCustomerId ?? (subscription.customerId || null),
          trialEndsAt: subscription.trialEnd ? new Date(subscription.trialEnd * 1000) : null,
          currentPeriodEnd: subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd * 1000) : null,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          lastEventAt: created,
        },
      });
      if (updated.plan !== row.plan || updated.status !== row.status) {
        await tx.auditLog.create({
          data: billingAudit(storeId, "subscription.plan_changed", before, {
            plan: updated.plan,
            status: updated.status,
            stripeEventId: eventId,
          }),
        });
      }
      return { result: "applied" as const };
    }

    if (event.type === "invoice.payment_failed") {
      if (!row.paymentFailedAt) {
        await tx.storeSubscription.update({ where: { storeId }, data: { paymentFailedAt: new Date() } });
        await tx.auditLog.create({
          data: billingAudit(storeId, "subscription.payment_failed", before, { stripeEventId: eventId, invoiceId: invoice!.id }),
        });
        return { result: "applied" as const, alert: storeId };
      }
      return { result: "applied" as const };
    }
    if (event.type === "invoice.paid" && row.paymentFailedAt) {
      await tx.storeSubscription.update({ where: { storeId }, data: { paymentFailedAt: null } });
      await tx.auditLog.create({
        data: billingAudit(storeId, "subscription.payment_recovered", before, { stripeEventId: eventId, invoiceId: invoice!.id }),
      });
    }
    return { result: "applied" as const };
  });

  if ("alert" in outcome && outcome.alert) await alertPaymentFailed(outcome.alert);
  return outcome.result;
}

function billingAudit(storeId: string, action: string, before: Prisma.InputJsonValue, after: Prisma.InputJsonValue) {
  return {
    storeId,
    actorId: SYSTEM_ACTOR_ID,
    actorEmail: SYSTEM_ACTOR_EMAIL,
    action,
    entityType: "store_subscription",
    entityId: storeId,
    before,
    after,
  };
}

async function resolveStore(
  tx: Tx,
  subscription: WebhookEvent["subscription"],
  invoice: WebhookEvent["invoice"],
): Promise<string | null> {
  const claimedStore = subscription?.storeId ?? invoice?.storeId ?? null;
  const subscriptionId = subscription?.id ?? invoice?.subscriptionId ?? null;
  const customerId = subscription?.customerId || invoice?.customerId || null;
  const or: Prisma.StoreSubscriptionWhereInput[] = [];
  if (subscriptionId) or.push({ stripeSubscriptionId: subscriptionId });
  if (customerId) or.push({ stripeCustomerId: customerId });
  const known = or.length ? await tx.storeSubscription.findFirst({ where: { OR: or }, select: { storeId: true } }) : null;
  if (known) return known.storeId;
  // Metadata alone is trusted only when the store exists and has not been linked to another customer.
  if (!claimedStore) return null;
  const store = await tx.store.findUnique({ where: { id: claimedStore }, select: { id: true } });
  if (!store) return null;
  const linked = await tx.storeSubscription.findUnique({ where: { storeId: claimedStore }, select: { stripeCustomerId: true } });
  if (linked?.stripeCustomerId && customerId && linked.stripeCustomerId !== customerId) return null;
  return claimedStore;
}

/** The storefront stays up; the owner sees a banner and every platform admin gets an email. */
async function alertPaymentFailed(storeId: string): Promise<void> {
  const store = await platformAdmin.store.findUnique({ where: { id: storeId }, select: { name: true, slug: true } });
  console.error(JSON.stringify({ event: "store_subscription_payment_failed", storeId }));
  const admins = await authPrisma.user.findMany({ where: { role: "platform_admin" }, select: { email: true } });
  await Promise.allSettled(
    admins.map((admin) =>
      sendEmail({
        to: admin.email,
        subject: `Subscription payment failed: ${store?.name ?? storeId}`,
        html: `<p>The monthly subscription payment for <strong>${escapeHtml(store?.name ?? storeId)}</strong> (${escapeHtml(store?.slug ?? "")}) failed. The storefront stays up. Stripe retries the card; review the store in the admin console.</p>`,
        idempotencyKey: `subscription-failed-${storeId}-${new Date().toISOString().slice(0, 10)}-${admin.email}`,
      }),
    ),
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
