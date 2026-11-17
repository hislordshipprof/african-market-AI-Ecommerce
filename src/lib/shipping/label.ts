import { storeScoped } from "../db";
import { deliveryProofBucket, shippingLabelKey, uploadShippingLabel } from "../r2";
import { cheapestRate, ShippingProviderError, type ShippingProvider } from "./provider";
import { shippingProvider } from "./settings";

/** The store absorbs a re-quoted rate up to this much above what the shopper paid (decision #568). */
export const POSTAGE_ABSORB_CENTS = 200;

/** A claim older than this was lost to a crash or timeout and may be taken again. */
const LABEL_CLAIM_STALE_MS = 5 * 60_000;

export const LABEL_STORAGE_NOT_SET_UP = "Shipping labels are not set up for this store yet. Contact support";
export const SHIPPING_UNAVAILABLE = "Shipping isn't available right now. Try again in a few minutes";
export const LABEL_NOT_BOUGHT = "The label could not be bought. Try again in a few minutes";
export const LABEL_BEING_BOUGHT = "The label is being bought";
export const POSTAGE_ROSE_PREFIX = "Postage went up from ";
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

function postageMessage(paidCents: number, newCents: number): string {
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
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
  const order = await scoped.order.findUnique({
    where: { id: orderId },
    include: { store: true, customer: true, lines: { include: { listingVariant: { select: { weightG: true } } } } },
  });
  if (!order || order.fulfillment !== "ship" || order.status !== "PICKING" || order.shippingPostageCents !== null) return { ok: true };
  if (!(deps.hasStorage ?? (() => deliveryProofBucket() !== null))()) return { ok: false, error: LABEL_STORAGE_NOT_SET_UP };

  if (order.shippingRateId && order.shippingRateExpiresAt && order.shippingRateExpiresAt > now) {
    await scoped.order.updateMany({ where: { id: orderId, shippingPostageCents: null }, data: { shippingPostageCents: order.deliveryFeeCents } });
    return { ok: true };
  }

  const provider = deps.provider === undefined ? shippingProvider() : deps.provider;
  if (!provider) return { ok: false, error: SHIPPING_UNAVAILABLE };
  const { store } = order;
  let rate;
  try {
    rate = cheapestRate(await provider.rates({
      from: { name: store.name, line1: store.addressLine1 ?? "", line2: store.addressLine2, city: store.city ?? "", state: store.state ?? "", zip: store.zip ?? "", phone: store.phone },
      to: { name: order.customer.name, line1: order.deliveryLine1 ?? "", line2: order.deliveryLine2, city: order.deliveryCity ?? "", state: order.deliveryState ?? "", zip: order.deliveryZip ?? "", phone: order.customer.phone },
      // The box the shopper was quoted for: every line as ordered.
      weightG: order.lines.reduce((sum, line) => sum + (line.listingVariant.weightG ?? 0) * line.qtyOrdered, 0),
    }));
  } catch (error) {
    if (!(error instanceof ShippingProviderError)) throw error;
    console.error(JSON.stringify({ event: "shipping_requote_failed", storeId, orderId, status: error.status }));
  }
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

export type LabelResult = { ok: true } | { ok: false; error: string };

/**
 * Buys the label for a captured shipped order and keeps its PDF in the private proof bucket. The order is claimed
 * first, so two clicks never buy two labels; a claim lost to a crash is retaken after five minutes.
 */
export async function buyShippingLabel(storeId: string, orderId: string, deps: LabelDeps = {}): Promise<LabelResult> {
  const now = (deps.now ?? (() => new Date()))();
  const scoped = storeScoped(storeId);
  if (!(deps.hasStorage ?? (() => deliveryProofBucket() !== null))()) return { ok: false, error: LABEL_STORAGE_NOT_SET_UP };
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
    const order = await scoped.order.findUnique({ where: { id: orderId }, select: { shippingLabelStatus: true } });
    if (order?.shippingLabelStatus === "bought") return { ok: true };
    return { ok: false, error: order?.shippingLabelStatus === "buying" ? LABEL_BEING_BOUGHT : "This order cannot get a label" };
  }
  const release = () => scoped.order.updateMany({ where: { id: orderId, shippingLabelStatus: "buying" }, data: { shippingLabelStatus: null, shippingLabelClaimedAt: null } });

  const provider = deps.provider === undefined ? shippingProvider() : deps.provider;
  if (!provider) {
    await release();
    return { ok: false, error: SHIPPING_UNAVAILABLE };
  }
  const order = await scoped.order.findUniqueOrThrow({ where: { id: orderId }, select: { shippingRateId: true } });
  try {
    const label = await provider.buyLabel(order.shippingRateId as string, orderId);
    const pdf = await provider.downloadLabel(label.labelUrl);
    const key = shippingLabelKey(orderId, label.labelId);
    await (deps.upload ?? uploadShippingLabel)(key, pdf);
    await scoped.order.updateMany({
      where: { id: orderId, shippingLabelStatus: "buying" },
      data: {
        shippingLabelStatus: "bought",
        shippingLabelId: label.labelId,
        shippingLabelKey: key,
        shippingTrackingNumber: label.trackingNumber,
        shippingTrackingUrl: label.trackingUrl,
      },
    });
    return { ok: true };
  } catch (error) {
    await release();
    if (!(error instanceof ShippingProviderError)) throw error;
    console.error(JSON.stringify({ event: "shipping_label_failed", storeId, orderId, status: error.status, message: error.message.slice(0, 200) }));
    return { ok: false, error: LABEL_NOT_BOUGHT };
  }
}
