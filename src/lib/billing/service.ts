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
import { escapeHtml } from "../notifications/messages";
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

/** Stripe statuses after which a subscription bills nothing more. */
const ENDED_STATUSES = new Set(["canceled", "incomplete_expired"]);

function hasLiveSubscription(row: { stripeSubscriptionId: string | null; status: string } | null): boolean {
  return Boolean(row?.stripeSubscriptionId) && !ENDED_STATUSES.has(row!.status);
}

/** The pilot's free months run from the first subscription; a store that already had one pays from day one. */
function pilotTrialAvailable(row: { pilot: boolean; stripeSubscriptionId: string | null } | null): boolean {
  return Boolean(row?.pilot) && !row?.stripeSubscriptionId;
}

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
    subscribed: hasLiveSubscription(row),
    pilotTrialAvailable: pilotTrialAvailable(row),
  };
}

export function pilotTrialEnd(from: Date): Date {
  const end = new Date(from);
  end.setUTCMonth(end.getUTCMonth() + PILOT_FREE_MONTHS);
  return end;
}

type Tx = Parameters<Parameters<typeof platformAdminTransaction>[0]>[0];

/** Room for the Stripe calls made while the billing row is locked. */
const STRIPE_TX = { timeout: 30_000 };

async function lockedRow(tx: Tx, storeId: string) {
  await lockStoreSubscriptionRow(tx, storeId);
  return tx.storeSubscription.findUniqueOrThrow({ where: { storeId } });
}

/**
 * Owner picks a plan: a hosted Checkout for a new subscription, the Customer Portal once subscribed.
 * The row stays locked while Stripe is called, so a second click or tab cannot open a second Checkout.
 * `pending` means the owner already paid in the open Checkout and the subscription has not arrived yet.
 */
export async function startSubscription(input: {
  storeId: string;
  storeName: string;
  plan: Plan;
  owner: Actor;
  returnUrl: string;
  now?: Date;
}): Promise<{ url: string } | { pending: true }> {
  const provider = getBillingProvider();
  const now = input.now ?? new Date();
  return platformAdminTransaction(async (tx) => {
    const row = await lockedRow(tx, input.storeId);
    let customerId = row.stripeCustomerId;
    if (!customerId) {
      customerId = await provider.createCustomer({ storeId: input.storeId, name: input.storeName, email: input.owner.email });
      await tx.storeSubscription.update({ where: { storeId: input.storeId }, data: { stripeCustomerId: customerId } });
    }
    if (hasLiveSubscription(row)) {
      return provider.createPortalSession({ customerId, returnUrl: input.returnUrl });
    }
    if (row.checkoutSessionId && (await provider.closeCheckoutSession(row.checkoutSessionId)) === "complete") {
      return { pending: true as const };
    }
    const checkout = await provider.createCheckoutSession({
      customerId,
      plan: input.plan,
      storeId: input.storeId,
      trialEnd: pilotTrialAvailable(row) ? Math.floor(pilotTrialEnd(now).getTime() / 1000) : null,
      successUrl: input.returnUrl,
      cancelUrl: input.returnUrl,
    });
    await tx.storeSubscription.update({ where: { storeId: input.storeId }, data: { checkoutSessionId: checkout.id } });
    return { url: checkout.url };
  }, STRIPE_TX);
}

export async function openBillingPortal(storeId: string, returnUrl: string): Promise<{ url: string } | null> {
  const row = await storeScoped(storeId).storeSubscription.findUnique({ where: { storeId } });
  if (!row?.stripeCustomerId) return null;
  return getBillingProvider().createPortalSession({ customerId: row.stripeCustomerId, returnUrl });
}

/**
 * Platform admin grants or removes the pilot offer. At most PILOT_STORE_CAP pilot stores.
 * Removal ends a running free trial in Stripe (ADR-0021: only pilot stores get the free months);
 * once a store has had its free months it keeps its pilot place, so the 5-store count stays true.
 */
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
    } else if (row.stripeSubscriptionId && row.trialEndsAt && row.trialEndsAt <= now) {
      return { ok: false as const, error: "This store has already had its free months, so it keeps its pilot place." };
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
  if (!changed) return { ok: true };
  const provider = getBillingProvider();
  try {
    // An open Checkout was priced with the old offer; the owner starts a fresh one.
    if (row.checkoutSessionId) await provider.closeCheckoutSession(row.checkoutSessionId);
    if (hasLiveSubscription(row)) {
      // Granted after subscribing: move the first charge past the free months. Removed mid-trial: charge now.
      if (pilot) await provider.setTrialEnd(row.stripeSubscriptionId!, Math.floor(pilotTrialEnd(now).getTime() / 1000));
      else {
        // Stripe, not the row: the trialing webhook from the grant may not have landed yet.
        const sub = await provider.getSubscription(row.stripeSubscriptionId!);
        if (sub.status === "trialing" || (sub.trialEnd && sub.trialEnd * 1000 > now.getTime())) {
          await provider.setTrialEnd(row.stripeSubscriptionId!, "now");
        }
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "pilot_trial_not_set", storeId, pilot, error: err instanceof Error ? err.message : "unknown" }));
    await platformAdminTransaction(async (tx) => {
      await tx.storeSubscription.update({ where: { storeId }, data: { pilot: !pilot } });
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: actor.id,
          actorEmail: actor.email,
          action: "subscription.pilot_reverted",
          entityType: "store_subscription",
          entityId: storeId,
          before: { pilot },
          after: { pilot: !pilot },
        },
      });
    });
    return {
      ok: false,
      error: pilot
        ? "Stripe did not accept the free months. Nothing changed; try again."
        : "Stripe did not end the free months. Nothing changed; try again.",
    };
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

export type BillingEventResult = "applied" | "replayed" | "stale" | "duplicate_canceled" | "unknown_store" | "ignored";

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
      let sub = subscription;
      // Before the stale check: a second subscription is cancelled whatever its event's timestamp.
      if (row.stripeSubscriptionId && row.stripeSubscriptionId !== sub.id && hasLiveSubscription(row)) {
        if (event.type !== "customer.subscription.created" || ENDED_STATUSES.has(sub.status)) {
          // An event for a subscription the store has since replaced, or a duplicate already cancelled.
          return { result: "stale" as const };
        }
        // A second live subscription on one store: keep the first, cancel this one so it is not billed.
        await getBillingProvider().cancelSubscription(sub.id);
        await tx.auditLog.create({
          data: billingAudit(storeId, "subscription.duplicate_canceled", before, {
            keptSubscriptionId: row.stripeSubscriptionId,
            canceledSubscriptionId: sub.id,
            stripeEventId: eventId,
          }),
        });
        return { result: "duplicate_canceled" as const, duplicate: { storeId, subscriptionId: sub.id } };
      }
      if (row.lastEventAt && created < row.lastEventAt) return { result: "stale" as const };
      if (row.lastEventAt && created.getTime() === row.lastEventAt.getTime() && sub.id === row.stripeSubscriptionId) {
        // Stripe's `created` is whole seconds, so on a tie this payload may be the older snapshot.
        sub = await getBillingProvider().getSubscription(sub.id);
      }
      const plan = planForLookupKey(sub.lookupKey) ?? (row.plan as Plan);
      const deleted = event.type === "customer.subscription.deleted";
      const status = deleted ? "canceled" : sub.status;
      const updated = await tx.storeSubscription.update({
        where: { storeId },
        data: {
          plan,
          status,
          stripeSubscriptionId: sub.id,
          stripeCustomerId: row.stripeCustomerId ?? (sub.customerId || null),
          trialEndsAt: sub.trialEnd ? new Date(sub.trialEnd * 1000) : null,
          currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000) : null,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          lastEventAt: created,
          // Any first event of a new subscription means its Checkout is done; `created` may arrive late or stale.
          ...(event.type === "customer.subscription.created" || sub.id !== row.stripeSubscriptionId ? { checkoutSessionId: null } : {}),
          ...(deleted ? { paymentFailedAt: null } : {}),
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

    if (row.stripeSubscriptionId && invoice!.subscriptionId && invoice!.subscriptionId !== row.stripeSubscriptionId) {
      // An invoice of a subscription the store no longer has (a cancelled duplicate or a replaced one).
      return { result: "stale" as const };
    }
    if (event.type === "invoice.payment_failed") {
      // A failure older than the newest paid invoice is a late re-delivery.
      if (row.paymentFailedAt || (row.lastInvoicePaidAt && created <= row.lastInvoicePaidAt)) return { result: "applied" as const };
      await tx.storeSubscription.update({ where: { storeId }, data: { paymentFailedAt: created } });
      await tx.auditLog.create({
        data: billingAudit(storeId, "subscription.payment_failed", before, { stripeEventId: eventId, invoiceId: invoice!.id }),
      });
      return { result: "applied" as const, alert: storeId };
    }
    if (event.type === "invoice.paid") {
      const recovered = row.paymentFailedAt !== null && row.paymentFailedAt <= created;
      await tx.storeSubscription.update({
        where: { storeId },
        data: {
          lastInvoicePaidAt: row.lastInvoicePaidAt && row.lastInvoicePaidAt > created ? row.lastInvoicePaidAt : created,
          ...(recovered ? { paymentFailedAt: null } : {}),
        },
      });
      if (recovered) {
        await tx.auditLog.create({
          data: billingAudit(storeId, "subscription.payment_recovered", before, { stripeEventId: eventId, invoiceId: invoice!.id }),
        });
      }
    }
    return { result: "applied" as const };
  }, STRIPE_TX);

  if ("alert" in outcome && outcome.alert) await alertPaymentFailed(outcome.alert);
  if ("duplicate" in outcome && outcome.duplicate) await alertDuplicateCanceled(outcome.duplicate.storeId, outcome.duplicate.subscriptionId);
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

async function emailPlatformAdmins(subject: string, html: string, key: string): Promise<void> {
  const admins = await authPrisma.user.findMany({ where: { role: "platform_admin" }, select: { email: true } });
  await Promise.allSettled(
    admins.map((admin) => sendEmail({ to: admin.email, subject, html, idempotencyKey: `${key}-${admin.email}` })),
  );
}

/** The storefront stays up; the owner sees a banner and every platform admin gets an email. */
async function alertPaymentFailed(storeId: string): Promise<void> {
  const store = await platformAdmin.store.findUnique({ where: { id: storeId }, select: { name: true, slug: true } });
  console.error(JSON.stringify({ event: "store_subscription_payment_failed", storeId }));
  await emailPlatformAdmins(
    `Subscription payment failed: ${store?.name ?? storeId}`,
    `<p>The monthly subscription payment for <strong>${escapeHtml(store?.name ?? storeId)}</strong> (${escapeHtml(store?.slug ?? "")}) failed. The storefront stays up. Stripe retries the card; review the store in the admin console.</p>`,
    `subscription-failed-${storeId}-${new Date().toISOString().slice(0, 10)}`,
  );
}

/** A cancelled duplicate may already have been charged; an admin refunds it in Stripe. */
async function alertDuplicateCanceled(storeId: string, subscriptionId: string): Promise<void> {
  const store = await platformAdmin.store.findUnique({ where: { id: storeId }, select: { name: true, slug: true } });
  console.error(JSON.stringify({ event: "store_subscription_duplicate_canceled", storeId, subscriptionId }));
  await emailPlatformAdmins(
    `Duplicate subscription cancelled: ${store?.name ?? storeId}`,
    `<p><strong>${escapeHtml(store?.name ?? storeId)}</strong> (${escapeHtml(store?.slug ?? "")}) started a second subscription, <code>${escapeHtml(subscriptionId)}</code>. It was cancelled and the first one kept. If Stripe charged it, refund that payment in the Stripe dashboard.</p>`,
    `subscription-duplicate-${subscriptionId}`,
  );
}
