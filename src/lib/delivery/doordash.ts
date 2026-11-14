import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  DeliveryProviderError,
  type CourierEventType,
  type CreatedDelivery,
  type DeliveryAddress,
  type DeliveryProvider,
  type DeliveryQuote,
  type DeliveryRequest,
  type DeliveryWebhookEvent,
} from "./provider";

const BASE_URL = "https://openapi.doordash.com";
const KEY_NAMES = ["DOORDASH_DEVELOPER_ID", "DOORDASH_KEY_ID", "DOORDASH_SIGNING_SECRET"] as const;
// DoorDash allows up to 30 minutes; a fresh token per request keeps it short.
const JWT_TTL_SECONDS = 300;
// "You must accept a quote within 5 minutes": https://developer.doordash.com/en-US/docs/drive/how_to/quote_deliveries
const QUOTE_TTL_MS = 5 * 60_000;

export interface DoorDashOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
}

type Json = Record<string, unknown>;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** JWT format: https://developer.doordash.com/en-US/docs/drive/reference/JWTs */
function signJwt(developerId: string, keyId: string, signingSecret: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT", "dd-ver": "DD-JWT-V1" }));
  const claims = base64url(JSON.stringify({ aud: "doordash", iss: developerId, kid: keyId, iat, exp: iat + JWT_TTL_SECONDS }));
  const signature = createHmac("sha256", Buffer.from(signingSecret, "base64url")).update(`${header}.${claims}`).digest();
  return `${header}.${claims}.${base64url(signature)}`;
}

/** Signed calls to the DoorDash Drive API. Keys are read per call so a missing key fails there, not at import. */
export function createDoorDashClient(opts: DoorDashOptions = {}) {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());

  return async function request(method: "GET" | "POST" | "PUT", path: string, body?: Json): Promise<Json> {
    const missing = KEY_NAMES.filter((name) => !env[name]);
    if (missing.length) throw new Error(`DoorDash Drive is not configured: missing ${missing.join(", ")}`);
    const token = signJwt(env.DOORDASH_DEVELOPER_ID!, env.DOORDASH_KEY_ID!, env.DOORDASH_SIGNING_SECRET!, now());
    const res = await doFetch(`${BASE_URL}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    // Error body: { code, message, field_errors? } https://developer.doordash.com/en-US/docs/drive/reference/errors
    if (!res.ok) {
      throw new DeliveryProviderError(
        "doordash",
        res.status,
        typeof json.code === "string" ? json.code : "unknown",
        `DoorDash ${method} ${path} failed with ${res.status}: ${typeof json.message === "string" ? json.message : "no message"}`,
      );
    }
    return json;
  };
}

export type DoorDashRequest = ReturnType<typeof createDoorDashClient>;

/** DoorDash takes one comma-separated address string. */
export function doordashAddress(address: DeliveryAddress): string {
  return [address.line1, address.line2, address.city, `${address.state} ${address.zip}`].filter(Boolean).join(", ");
}

function optionalDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function feeCents(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error("DoorDash returned an invalid fee");
  return value as number;
}

// Webhook event names: https://developer.doordash.com/en-US/docs/drive/reference/webhooks
const EVENT_TYPES: Record<string, CourierEventType> = {
  DASHER_CONFIRMED: "courier_assigned",
  DASHER_PICKED_UP: "picked_up",
  DASHER_DROPPED_OFF: "delivered",
  DELIVERY_CANCELLED: "cancelled",
  DELIVERY_RETURNED: "returned",
};

/** The webhook's Authorization header is missing or is not the value set in the Developer Portal. */
export class DoorDashWebhookAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoorDashWebhookAuthError";
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export class DoorDashDriveProvider implements DeliveryProvider {
  readonly name = "doordash" as const;
  private readonly request: DoorDashRequest;
  private readonly now: () => Date;
  private readonly env: Record<string, string | undefined>;

  constructor(opts: DoorDashOptions = {}) {
    this.request = createDoorDashClient(opts);
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => new Date());
  }

  /** POST /drive/v2/quotes: https://developer.doordash.com/en-US/api/drive/ */
  async quote(req: DeliveryRequest): Promise<DeliveryQuote> {
    const requestedAt = this.now();
    const res = await this.request("POST", "/drive/v2/quotes", {
      external_delivery_id: req.externalDeliveryId,
      locale: "en-US",
      pickup_address: doordashAddress(req.pickup.address),
      pickup_business_name: req.pickup.businessName,
      pickup_phone_number: req.pickup.phone,
      pickup_external_business_id: req.pickup.providerBusinessId,
      pickup_external_store_id: req.pickup.providerStoreId,
      dropoff_address: doordashAddress(req.dropoff.address),
      dropoff_phone_number: req.dropoff.phone,
      dropoff_contact_given_name: req.dropoff.givenName,
      dropoff_contact_family_name: req.dropoff.familyName,
      dropoff_instructions: req.dropoff.instructions,
      // A PIN drop-off cannot be contactless. pin_code_type is only documented for returns ("merchant_provided_number").
      contactless_dropoff: req.dropoffPin ? false : req.dropoff.contactless,
      dropoff_options: { proof_of_delivery: req.dropoffPin ? "pin_code" : "photo_required" },
      dropoff_pin_code_verification_metadata: req.dropoffPin
        ? { pin_code_type: "merchant_provided_number", pin_code_value: req.dropoffPin }
        : undefined,
      order_value: req.orderValueCents,
      tip: req.tipCents,
    });
    return {
      quoteId: String(res.external_delivery_id),
      feeCents: feeCents(res.fee),
      currency: typeof res.currency === "string" ? res.currency : "USD",
      pickupEta: optionalDate(res.pickup_time_estimated),
      dropoffEta: optionalDate(res.dropoff_time_estimated),
      expiresAt: new Date(requestedAt.getTime() + QUOTE_TTL_MS),
    };
  }

  /** POST /drive/v2/quotes/{external_delivery_id}/accept turns the quote into a delivery. */
  async create(quoteId: string, req: DeliveryRequest): Promise<CreatedDelivery> {
    const res = await this.request("POST", `/drive/v2/quotes/${encodeURIComponent(quoteId)}/accept`, {
      tip: req.tipCents,
      dropoff_phone_number: req.dropoff.phone,
    });
    return {
      externalId: String(res.external_delivery_id ?? quoteId),
      trackingUrl: typeof res.tracking_url === "string" ? res.tracking_url : null,
      pin: req.dropoffPin ?? null,
    };
  }

  /** PUT /drive/v2/deliveries/{external_delivery_id}/cancel */
  async cancel(externalId: string): Promise<void> {
    await this.request("PUT", `/drive/v2/deliveries/${encodeURIComponent(externalId)}/cancel`);
  }

  /**
   * Checks and parses one webhook. DoorDash signs no webhook body: it sends the Authorization header value set in the
   * Developer Portal (Basic Auth option), https://developer.doordash.com/en-US/docs/drive/how_to/webhooks.
   * DOORDASH_WEBHOOK_AUTHORIZATION holds that exact value.
   */
  handleWebhook(raw: string, headers: Headers): DeliveryWebhookEvent {
    const expected = this.env.DOORDASH_WEBHOOK_AUTHORIZATION;
    if (!expected) throw new Error("DoorDash webhooks are not configured: missing DOORDASH_WEBHOOK_AUTHORIZATION");
    const given = headers.get("authorization");
    if (!given) throw new DoorDashWebhookAuthError("Missing Authorization header");
    if (!timingSafeEqual(digest(given), digest(expected))) throw new DoorDashWebhookAuthError("Authorization header does not match");

    const body = JSON.parse(raw) as Json;
    const eventName = body.event_name;
    const externalDeliveryId = body.external_delivery_id;
    const occurredAt = optionalDate(body.created_at);
    if (typeof eventName !== "string" || typeof externalDeliveryId !== "string" || !occurredAt) {
      throw new Error("DoorDash webhook is missing event_name, external_delivery_id or created_at");
    }
    const vehicle = [body.dasher_vehicle_make, body.dasher_vehicle_model].filter((v) => typeof v === "string").join(" ");
    const hasCourier = typeof body.dasher_name === "string" || vehicle !== "";
    return {
      provider: "doordash",
      externalDeliveryId,
      // DoorDash sends no event id; a retry repeats the same name, delivery and created_at.
      externalEventId: `${eventName}:${externalDeliveryId}:${occurredAt.toISOString()}`,
      type: EVENT_TYPES[eventName] ?? null,
      occurredAt,
      trackingUrl: typeof body.tracking_url === "string" ? body.tracking_url : null,
      actualFeeCents: body.fee === undefined ? null : feeCents(body.fee),
      courier: hasCourier
        ? {
            name: typeof body.dasher_name === "string" ? body.dasher_name : null,
            vehicle: vehicle || null,
            dropoffEta: optionalDate(body.dropoff_time_estimated),
          }
        : null,
      // DoorDash reports no entered PIN: a pin_code delivery cannot be dropped off without it.
      proof: { photoUrl: typeof body.dropoff_verification_image_url === "string" ? body.dropoff_verification_image_url : null, pinEntered: null },
      payload: body,
    };
  }
}
