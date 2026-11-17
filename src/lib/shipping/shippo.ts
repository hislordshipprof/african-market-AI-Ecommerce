import { createHmac, timingSafeEqual } from "node:crypto";
import { PARCEL_BOX_IN, ShippingProviderError, type BoughtLabel, type ParcelAddress, type ParcelRate, type ParcelRequest, type ShippingProvider, type VoidOutcome } from "./provider";

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

  private async post(path: string, body: Json): Promise<Json> {
    if (!this.apiKey) throw new ShippingProviderError(0, "Shippo is not configured: missing SHIPPO_API_KEY");
    const res = await this.doFetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { authorization: `ShippoToken ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw new ShippingProviderError(res.status, `Shippo POST ${path} failed with ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  }

  async rates(req: ParcelRequest): Promise<ParcelRate[]> {
    const quotedAt = this.now();
    const json = await this.post("/shipments/", {
      address_from: shippoAddress(req.from),
      address_to: shippoAddress(req.to),
      parcels: [{ ...PARCEL_BOX_IN, distance_unit: "in", weight: (req.weightG / 453.59237).toFixed(2), mass_unit: "lb" }],
      async: false,
    });
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

  /** POST /transactions buys the rate as a 4×6 PDF label (https://docs.goshippo.com/api-reference/transactions/create-a-shipping-label). */
  async buyLabel(rateId: string, orderId: string): Promise<BoughtLabel> {
    const json = await this.post("/transactions/", { rate: rateId, label_file_type: "PDF_4x6", async: false, metadata: orderId });
    const ok = json.status === "SUCCESS" && typeof json.object_id === "string" && typeof json.tracking_number === "string"
      && typeof json.label_url === "string" && json.label_url.startsWith("https://");
    if (!ok) throw new ShippingProviderError(422, `Shippo label not bought (${String(json.status)}): ${JSON.stringify(json.messages ?? []).slice(0, 300)}`);
    return {
      labelId: json.object_id as string,
      trackingNumber: json.tracking_number as string,
      trackingUrl: typeof json.tracking_url_provider === "string" && json.tracking_url_provider.startsWith("https://") ? json.tracking_url_provider : null,
      labelUrl: json.label_url as string,
    };
  }

  async downloadLabel(labelUrl: string): Promise<Uint8Array> {
    const res = await this.doFetch(labelUrl, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
    if (!res.ok) throw new ShippingProviderError(res.status, `Shippo label download failed with ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!isPdf(bytes)) throw new ShippingProviderError(422, "Shippo label is not a PDF");
    return bytes;
  }

  /** POST /refunds voids the label; Shippo answers ERROR when the carrier has scanned it (https://docs.goshippo.com/api-reference/refunds/). */
  async voidLabel(labelId: string): Promise<VoidOutcome> {
    const json = await this.post("/refunds/", { transaction: labelId, async: false });
    if (json.status === "ERROR") return "refused";
    if (["QUEUED", "PENDING", "SUCCESS"].includes(json.status as string)) return "voided";
    throw new ShippingProviderError(422, `Shippo refund answered ${String(json.status)}`);
  }
}

export const LABEL_MAX_BYTES = 2 * 1024 * 1024;

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.byteLength > 4 && bytes.byteLength <= LABEL_MAX_BYTES && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
}

/** How old a signed webhook may be; Shippo retries within minutes. */
export const SHIPPO_WEBHOOK_TOLERANCE_S = 300;

/**
 * Shippo's HMAC webhook signature (https://docs.goshippo.com/tracking/webhook-security.md): the header
 * `Shippo-Auth-Signature: t=<unix seconds>,v1=<hex>`, where v1 is HMAC-SHA256 of "<t>.<raw body>" with the shared secret.
 */
export function verifyShippoSignature(raw: string, header: string | null, secret: string, now: Date = new Date()): boolean {
  if (!header || !secret) return false;
  const parts = new Map(header.split(",").map((part) => {
    const at = part.indexOf("=");
    return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as const;
  }));
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !/^\d{1,12}$/.test(t) || !v1 || !/^[a-f0-9]{64}$/i.test(v1)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(t)) > SHIPPO_WEBHOOK_TOLERANCE_S) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest();
  return timingSafeEqual(expected, Buffer.from(v1, "hex"));
}

export function signShippoWebhook(raw: string, secret: string, now: Date = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
}

/** The Shippo tracking statuses (https://docs.goshippo.com/tracking/tracking.md). */
export type TrackingStatus = "PRE_TRANSIT" | "TRANSIT" | "DELIVERED" | "RETURNED" | "FAILURE" | "UNKNOWN";

export interface TrackingEvent {
  /** The tracking status's own object id: one per carrier event, so a retried webhook repeats it. */
  eventId: string;
  labelId: string;
  status: TrackingStatus;
  test: boolean;
  payload: Json;
}

const STATUSES: readonly TrackingStatus[] = ["PRE_TRANSIT", "TRANSIT", "DELIVERED", "RETURNED", "FAILURE", "UNKNOWN"];

/** Reads a `track_updated` body; null for any other event or a body without a transaction and status id. */
export function parseTrackUpdated(raw: string): TrackingEvent | null {
  let body: Json;
  try {
    body = JSON.parse(raw) as Json;
  } catch {
    return null;
  }
  if (body?.event !== "track_updated" || !body.data || typeof body.data !== "object") return null;
  const data = body.data as Json;
  const status = data.tracking_status as Json | undefined;
  const transaction = typeof data.transaction === "string" ? data.transaction : (data.transaction as Json | undefined)?.object_id;
  if (typeof transaction !== "string" || !transaction || transaction.length > 200) return null;
  if (!status || typeof status.object_id !== "string" || !status.object_id || status.object_id.length > 200) return null;
  if (!STATUSES.includes(status.status as TrackingStatus)) return null;
  return { eventId: status.object_id, labelId: transaction, status: status.status as TrackingStatus, test: body.test === true, payload: body };
}
