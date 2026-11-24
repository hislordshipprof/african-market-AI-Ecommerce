import { storeScoped } from "../db";
import { deliveryProofBucket, shippingLabelKey, uploadShippingLabel } from "../r2";
import { cheapestRate, ShippingProviderError, type BoughtLabel, type ParcelRate, type ShippingProvider } from "./provider";
import { shippingProvider } from "./settings";

/** The store absorbs a re-quoted rate up to this much above what the shopper paid (decision #568). */
export const POSTAGE_ABSORB_CENTS = 200;
/** After capture the platform absorbs a re-quoted rate up to this much above the captured postage (decision 2026-11-23-13). */
export const PLATFORM_POSTAGE_ABSORB_CENTS = 500;

/** A claim older than this was lost to a crash or timeout and may be taken again. */
const LABEL_CLAIM_STALE_MS = 5 * 60_000;

export const LABEL_STORAGE_NOT_SET_UP = "Shipping labels are not set up for this store yet. Contact support";
export const SHIPPING_UNAVAILABLE = "Shipping isn't available right now. Try again in a few minutes";
export const LABEL_NOT_BOUGHT = "The label could not be bought. Try again in a few minutes";
export const LABEL_PDF_NOT_SAVED = "The label is bought but its PDF could not be saved. Try again in a few minutes";
export const LABEL_BEING_BOUGHT = "The label is being bought";
export const POSTAGE_ROSE_PREFIX = "Postage went up from ";
export const LABEL_RATE_EXPIRED_PREFIX = "The rate for this label expired. ";
export const SHIPMENT_SCANNED = "The carrier has scanned this parcel, so it can no longer be cancelled";

export type PostageResult =
  | { ok: true }
  | { ok: false; error: string; confirmPostageCents?: number };

export interface LabelDeps {
  provider?: ShippingProvider | null;
  upload?: (key: string, body: Uint8Array) => Promise<void>;
  hasStorage?: () => boolean;
  now?: () => Date;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function postageMessage(paidCents: number, newCents: number): string {
  return `${POSTAGE_ROSE_PREFIX}${dollars(paidCents)} to ${dollars(newCents)}. The store pays the ${dollars(newCents - paidCents)} difference. Confirm to buy the label`;
}

/**
 * Fixes the postage a shipped order's label is bought at, before Ready captures (#568). The rate the shopper accepted
 * is kept while Shippo still sells it; past its expiry the parcel is quoted again. A rise up to $2 is absorbed by the
 * store; a larger rise needs staff to confirm that exact amount. The postage is written once, so a retry keeps it.
 */
export async function fixPostage(storeId: string, orderId: string, confirmPostageCents: number | undefined, deps: LabelDeps = {}): Promise<PostageResult> {
  const now = (deps.now ?? (() => new Date()))();
  const scoped = storeScoped(storeId);
  const order = await scoped.order.findUnique({ where: { id: orderId } });
  if (!order || order.fulfillment !== "ship" || order.status !== "PICKING" || order.shippingPostageCents !== null) return { ok: true };
  if (!(deps.hasStorage ?? (() => deliveryProofBucket() !== null))()) return { ok: false, error: LABEL_STORAGE_NOT_SET_UP };

  if (order.shippingRateId && order.shippingRateExpiresAt && order.shippingRateExpiresAt > now) {
    await scoped.order.updateMany({ where: { id: orderId, shippingPostageCents: null }, data: { shippingPostageCents: order.deliveryFeeCents } });
    return { ok: true };
  }

  const provider = deps.provider === undefined ? shippingProvider() : deps.provider;
  if (!provider) return { ok: false, error: SHIPPING_UNAVAILABLE };
  const rate = await requote(storeId, orderId, provider);
  if (!rate) return { ok: false, error: SHIPPING_UNAVAILABLE };
  if (rate.feeCents - order.deliveryFeeCents > POSTAGE_ABSORB_CENTS && confirmPostageCents !== rate.feeCents) {
    return { ok: false, error: postageMessage(order.deliveryFeeCents, rate.feeCents), confirmPostageCents: rate.feeCents };
  }
  await scoped.order.updateMany({
    where: { id: orderId, status: "PICKING", shippingPostageCents: null },
    data: {
      shippingPostageCents: rate.feeCents,
      shippingRateId: rate.rateId,
      shippingRateExpiresAt: rate.expiresAt,
      shippingCarrier: rate.carrier,
      shippingService: rate.service,
      shippingDays: rate.days,
    },
  });
  return { ok: true };
}

/** The cheapest rate for the order's parcel now: the box the shopper was quoted for, every line as ordered. */
async function requote(storeId: string, orderId: string, provider: ShippingProvider): Promise<ParcelRate | null> {
  const order = await storeScoped(storeId).order.findUniqueOrThrow({
    where: { id: orderId },
    include: { store: true, customer: true, lines: { include: { listingVariant: { select: { weightG: true } } } } },
  });
  const { store } = order;
  try {
    return cheapestRate(await provider.rates({
      from: { name: store.name, line1: store.addressLine1 ?? "", line2: store.addressLine2, city: store.city ?? "", state: store.state ?? "", zip: store.zip ?? "", phone: store.phone },
      to: { name: order.customer.name, line1: order.deliveryLine1 ?? "", line2: order.deliveryLine2, city: order.deliveryCity ?? "", state: order.deliveryState ?? "", zip: order.deliveryZip ?? "", phone: order.customer.phone },
      weightG: order.lines.reduce((sum, line) => sum + (line.listingVariant.weightG ?? 0) * line.qtyOrdered, 0),
    }));
  } catch (error) {
    if (!(error instanceof ShippingProviderError)) throw error;
    console.error(JSON.stringify({ event: "shipping_requote_failed", storeId, orderId, status: error.status }));
    return null;
  }
}

/**
 * `confirmPostageCents`: staff confirmed this fresh rate after Shippo refused the stored one (#771).
 * `offerCancel`: the fresh rate is more than $5 above the captured postage, so staff are offered cancel and refund.
 */
export type LabelResult = { ok: true } | { ok: false; error: string; confirmPostageCents?: number; offerCancel?: boolean };

function rateExpiredMessage(capturedCents: number, newCents: number): string {
  const rise = newCents - capturedCents;
  const change = rise > 0 ? `${dollars(rise)} more than` : rise < 0 ? `${dollars(-rise)} less than` : "the same as";
  const next = rise > PLATFORM_POSTAGE_ABSORB_CENTS
    ? `That is over the ${dollars(PLATFORM_POSTAGE_ABSORB_CENTS)} the platform covers, so cancel the shipment and refund the customer`
    : `${rise > 0 ? "The platform pays the difference. " : ""}Confirm to buy the label`;
  return `${LABEL_RATE_EXPIRED_PREFIX}The new rate is ${dollars(newCents)}, ${change} the shopper paid. ${next}`;
}

/**
 * Buys the label for a captured shipped order and keeps its PDF in the private proof bucket. The order is claimed
 * first, so two clicks never buy two labels; a claim lost to a crash is retaken after five minutes. A sold label is
 * saved before its PDF, so a failed download or upload never loses it: a retry fetches only the PDF again. A purchase
 * whose answer was lost, or a claim retaken, first looks the rate's label up, so Shippo never sells it twice.
 */
export async function buyShippingLabel(storeId: string, orderId: string, deps: LabelDeps = {}, confirmPostageCents?: number): Promise<LabelResult> {
  const now = (deps.now ?? (() => new Date()))();
  const scoped = storeScoped(storeId);
  if (!(deps.hasStorage ?? (() => deliveryProofBucket() !== null))()) return { ok: false, error: LABEL_STORAGE_NOT_SET_UP };
  const provider = deps.provider === undefined ? shippingProvider() : deps.provider;
  const before = await scoped.order.findUnique({ where: { id: orderId }, select: { shippingLabelStatus: true, shippingRateId: true, shippingPostageCents: true, deliveryFeeCents: true } });
  const claimed = await scoped.order.updateMany({
    where: {
      id: orderId,
      fulfillment: "ship",
      status: "READY",
      shippingRateId: { not: null },
      OR: [{ shippingLabelStatus: null }, { shippingLabelStatus: "buying", shippingLabelClaimedAt: { lt: new Date(now.getTime() - LABEL_CLAIM_STALE_MS) } }],
    },
    data: { shippingLabelStatus: "buying", shippingLabelClaimedAt: now },
  });
  if (claimed.count === 0) {
    const order = await scoped.order.findUnique({ where: { id: orderId }, select: { shippingLabelStatus: true, shippingLabelId: true, shippingLabelKey: true } });
    if (order?.shippingLabelStatus === "bought" && order.shippingLabelId) {
      if (order.shippingLabelKey) return { ok: true };
      if (!provider) return { ok: false, error: SHIPPING_UNAVAILABLE };
      return savePdf(storeId, orderId, order.shippingLabelId, () => provider.labelUrl(order.shippingLabelId as string), provider, deps);
    }
    return { ok: false, error: order?.shippingLabelStatus === "buying" ? LABEL_BEING_BOUGHT : "This order cannot get a label" };
  }
  const release = () => scoped.order.updateMany({ where: { id: orderId, shippingLabelStatus: "buying" }, data: { shippingLabelStatus: null, shippingLabelClaimedAt: null } });

  if (!provider) {
    await release();
    return { ok: false, error: SHIPPING_UNAVAILABLE };
  }
  const fail = (error: unknown, event: string) => {
    if (!(error instanceof ShippingProviderError)) throw error;
    console.error(JSON.stringify({ event, storeId, orderId, status: error.status, message: error.message.slice(0, 200) }));
    return { ok: false as const, error: LABEL_NOT_BOUGHT };
  };
  /** Buys the rate; a refusal (4xx) comes back as "refused", a lost answer is looked up so Shippo never sells it twice. */
  const buy = async (rateId: string): Promise<BoughtLabel | "refused" | LabelResult> => {
    try {
      return await provider.buyLabel(rateId, orderId);
    } catch (error) {
      if (!(error instanceof ShippingProviderError) || (error.status >= 400 && error.status < 500)) {
        await release();
        fail(error, "shipping_label_failed");
        return "refused";
      }
      // The answer was lost (timeout, 5xx, queued): Shippo may have sold it. The claim is kept unless the lookup says no sale.
      console.error(JSON.stringify({ event: "shipping_label_unknown", storeId, orderId, status: error.status, message: error.message.slice(0, 200) }));
      let found;
      try {
        found = await provider.findLabel(rateId);
      } catch (lookupError) {
        return fail(lookupError, "shipping_label_lookup_failed");
      }
      if (found) return found;
      await release();
      return { ok: false, error: LABEL_NOT_BOUGHT };
    }
  };

  let label: BoughtLabel | null = null;
  let labelPostageCents: number | null = null;
  // A claim retaken after a crash or failed write may have sold a label already: look for it before buying again.
  if (before?.shippingLabelStatus === "buying") {
    try {
      label = await provider.findLabel(before.shippingRateId as string);
    } catch (error) {
      return fail(error, "shipping_label_lookup_failed");
    }
  }
  if (!label) {
    let bought = await buy(before?.shippingRateId as string);
    if (bought === "refused") {
      // Shippo refused the rate for good, so nothing was sold on it (#771): quote the parcel again.
      const captured = before?.shippingPostageCents ?? before?.deliveryFeeCents ?? 0;
      const rate = await requote(storeId, orderId, provider);
      if (!rate) return { ok: false, error: SHIPPING_UNAVAILABLE };
      if (rate.feeCents - captured > PLATFORM_POSTAGE_ABSORB_CENTS) return { ok: false, error: rateExpiredMessage(captured, rate.feeCents), offerCancel: true };
      if (confirmPostageCents !== rate.feeCents) return { ok: false, error: rateExpiredMessage(captured, rate.feeCents), confirmPostageCents: rate.feeCents };
      // The claim again, now on the fresh rate, so a lost answer is looked up on the rate actually bought.
      const reclaimed = await scoped.order.updateMany({
        where: { id: orderId, status: "READY", shippingLabelStatus: null },
        data: {
          shippingLabelStatus: "buying", shippingLabelClaimedAt: now,
          shippingRateId: rate.rateId, shippingRateExpiresAt: rate.expiresAt, shippingCarrier: rate.carrier, shippingService: rate.service, shippingDays: rate.days,
        },
      });
      if (reclaimed.count === 0) return { ok: false, error: LABEL_BEING_BOUGHT };
      console.info(JSON.stringify({ event: "shipping_label_requoted", storeId, orderId, capturedCents: captured, labelCents: rate.feeCents }));
      labelPostageCents = rate.feeCents;
      bought = await buy(rate.rateId);
      if (bought === "refused") return { ok: false, error: LABEL_NOT_BOUGHT };
    }
    if ("ok" in bought) return bought;
    label = bought;
  }
  // Logged before the write, so a label sold while the database is down can still be found and voided.
  console.info(JSON.stringify({ event: "shipping_label_bought", storeId, orderId, labelId: label.labelId }));
  await scoped.order.updateMany({
    where: { id: orderId, shippingLabelStatus: "buying" },
    data: {
      shippingLabelStatus: "bought", shippingLabelId: label.labelId, shippingTrackingNumber: label.trackingNumber, shippingTrackingUrl: label.trackingUrl,
      ...(labelPostageCents !== null && { shippingLabelPostageCents: labelPostageCents }),
    },
  });
  const bought = label;
  return savePdf(storeId, orderId, bought.labelId, async () => bought.labelUrl, provider, deps);
}

async function savePdf(storeId: string, orderId: string, labelId: string, labelUrl: () => Promise<string>, provider: ShippingProvider, deps: LabelDeps): Promise<LabelResult> {
  try {
    const pdf = await provider.downloadLabel(await labelUrl());
    const key = shippingLabelKey(orderId, labelId);
    await (deps.upload ?? uploadShippingLabel)(key, pdf);
    await storeScoped(storeId).order.updateMany({ where: { id: orderId, shippingLabelId: labelId }, data: { shippingLabelKey: key } });
    return { ok: true };
  } catch (error) {
    console.error(JSON.stringify({ event: "shipping_label_pdf_failed", storeId, orderId, labelId, message: String(error).slice(0, 200) }));
    return { ok: false, error: LABEL_PDF_NOT_SAVED };
  }
}
