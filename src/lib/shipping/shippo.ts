import { PARCEL_BOX_IN, ShippingProviderError, type ParcelAddress, type ParcelRate, type ParcelRequest, type ShippingProvider } from "./provider";

const BASE_URL = "https://api.goshippo.com";
/** "only rates less than 7 days old can be purchased" (Shippo, create a shipping label). */
export const SHIPPO_RATE_PURCHASE_WINDOW_MS = 7 * 24 * 60 * 60_000;

type Json = Record<string, unknown>;

export interface ShippoOptions {
  apiKey?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

function shippoAddress(address: ParcelAddress): Json {
  return {
    name: address.name,
    street1: address.line1,
    street2: address.line2 ?? undefined,
    city: address.city,
    state: address.state,
    zip: address.zip,
    country: "US",
    phone: address.phone ?? undefined,
  };
}

/** Shippo amounts are decimal strings ("7.58"). */
function amountCents(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** POST /shipments with async false returns every rate in the response (https://docs.goshippo.com/api-reference/shipments/create-a-new-shipment). */
export class ShippoProvider implements ShippingProvider {
  readonly name = "shippo" as const;
  private readonly apiKey: string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly now: () => Date;

  constructor(opts: ShippoOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.SHIPPO_API_KEY;
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  async rates(req: ParcelRequest): Promise<ParcelRate[]> {
    if (!this.apiKey) throw new ShippingProviderError(0, "Shippo is not configured: missing SHIPPO_API_KEY");
    const quotedAt = this.now();
    const res = await this.doFetch(`${BASE_URL}/shipments/`, {
      method: "POST",
      headers: { authorization: `ShippoToken ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        address_from: shippoAddress(req.from),
        address_to: shippoAddress(req.to),
        parcels: [{ ...PARCEL_BOX_IN, distance_unit: "in", weight: (req.weightG / 453.59237).toFixed(2), mass_unit: "lb" }],
        async: false,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw new ShippingProviderError(res.status, `Shippo POST /shipments failed with ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    const rates = Array.isArray(json.rates) ? (json.rates as Json[]) : [];
    const expiresAt = new Date(quotedAt.getTime() + SHIPPO_RATE_PURCHASE_WINDOW_MS);
    return rates.flatMap((rate) => {
      const feeCents = amountCents(rate.amount);
      const level = rate.servicelevel as Json | undefined;
      if (feeCents == null || rate.currency !== "USD" || typeof rate.object_id !== "string" || typeof rate.provider !== "string") return [];
      return [{
        rateId: rate.object_id,
        carrier: rate.provider,
        service: typeof level?.name === "string" ? level.name : "",
        days: Number.isInteger(rate.estimated_days) ? (rate.estimated_days as number) : null,
        feeCents,
        expiresAt,
      }];
    });
  }
}
