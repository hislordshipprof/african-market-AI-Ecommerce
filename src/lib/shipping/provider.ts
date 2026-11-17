/**
 * Parcel shipping seam (ADR-0023, #567). Shippo implements it; checkout shows the cheapest rate,
 * at the carrier's price with no markup (ADR-0006). At Ready the store buys the label (#568).
 */

export interface ParcelAddress {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip: string;
  phone?: string | null;
}

export interface ParcelRequest {
  from: ParcelAddress;
  to: ParcelAddress;
  /** The whole order in grams; one box per order in v1. */
  weightG: number;
}

export interface ParcelRate {
  /** The provider's rate id; #568 buys the label with it. */
  rateId: string;
  carrier: string;
  service: string;
  /** Carrier transit days, when the carrier gives them. */
  days: number | null;
  feeCents: number;
  /** Past this the rate can no longer be bought and checkout asks again. */
  expiresAt: Date;
}

export interface BoughtLabel {
  /** The provider's transaction id; tracking webhooks name it. */
  labelId: string;
  trackingNumber: string;
  /** The carrier's own tracking page. */
  trackingUrl: string | null;
  /** A short-lived link to the label PDF. */
  labelUrl: string;
}

/** "voided" once the provider accepted the refund (it may still settle for days); "refused" after a carrier scan. */
export type VoidOutcome = "voided" | "refused";

export interface ShippingProvider {
  readonly name: "shippo";
  rates(req: ParcelRequest): Promise<ParcelRate[]>;
  buyLabel(rateId: string, orderId: string): Promise<BoughtLabel>;
  downloadLabel(labelUrl: string): Promise<Uint8Array>;
  voidLabel(labelId: string): Promise<VoidOutcome>;
}

export class ShippingProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ShippingProviderError";
  }
}

/** The one box every order ships in (decision #567): 12 × 10 × 8 in. */
export const PARCEL_BOX_IN = { length: 12, width: 10, height: 8 } as const;

/** The cheapest rate; a tie goes to the faster one. */
export function cheapestRate(rates: readonly ParcelRate[]): ParcelRate | null {
  let best: ParcelRate | null = null;
  for (const rate of rates) {
    if (rate.feeCents < 0) continue;
    if (!best || rate.feeCents < best.feeCents || (rate.feeCents === best.feeCents && (rate.days ?? 99) < (best.days ?? 99))) {
      best = rate;
    }
  }
  return best;
}
