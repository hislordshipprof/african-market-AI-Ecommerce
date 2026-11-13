import { createHmac, timingSafeEqual } from "node:crypto";
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

const AUTH_URL = "https://auth.uber.com/oauth/v2/token";
const API_URL = "https://api.uber.com";
const KEY_NAMES = ["UBER_DIRECT_CLIENT_ID", "UBER_DIRECT_CLIENT_SECRET", "UBER_DIRECT_CUSTOMER_ID"] as const;
const TIMEOUT_MS = 10_000;
// Renew a minute early so a token never expires between the check and Uber reading it.
const TOKEN_MARGIN_MS = 60_000;

export type UberScope = "eats.deliveries" | "direct.organizations";

export interface UberDirectOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
}

type Json = Record<string, unknown>;

// Uber allows 100 token requests an hour and a token lasts 30 days, so one token per client and scope
// is shared across the process: https://developer.uber.com/docs/deliveries/guides/authentication
const tokens = new Map<string, { value: string; expiresAt: number }>();
const pending = new Map<string, Promise<string>>();

async function send(doFetch: typeof fetch, url: string, init: RequestInit, label: string): Promise<{ res: Response; json: Json }> {
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new DeliveryProviderError(
      "uber",
      timedOut ? 504 : 502,
      timedOut ? "timeout" : "network_error",
      `Uber Direct ${label} ${timedOut ? "timed out" : `failed: ${error instanceof Error ? error.message : String(error)}`}`,
    );
  }
  return { res, json: (await res.json().catch(() => ({}))) as Json };
}

/** Bearer calls to the Uber Direct API. Keys are read per call so a missing key fails there, not at import. */
export function createUberDirectClient(opts: UberDirectOptions = {}) {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());

  function keys() {
    const missing = KEY_NAMES.filter((name) => !env[name]);
    if (missing.length) throw new Error(`Uber Direct is not configured: missing ${missing.join(", ")}`);
    return { clientId: env.UBER_DIRECT_CLIENT_ID!, clientSecret: env.UBER_DIRECT_CLIENT_SECRET!, customerId: env.UBER_DIRECT_CUSTOMER_ID! };
  }

  async function fetchToken(clientId: string, clientSecret: string, scope: UberScope): Promise<string> {
    const { res, json } = await send(
      doFetch,
      AUTH_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials", scope }).toString(),
      },
      "token request",
    );
    if (!res.ok || typeof json.access_token !== "string" || typeof json.expires_in !== "number") {
      const code = typeof json.error === "string" ? json.error : "token_error";
      throw new DeliveryProviderError("uber", res.ok ? 502 : res.status, code, `Uber Direct token request failed with ${res.status}: ${code}`);
    }
    tokens.set(`${clientId}:${scope}`, { value: json.access_token, expiresAt: now().getTime() + json.expires_in * 1000 });
    return json.access_token;
  }

  /** The cached token, or one new token shared by every caller waiting on it. */
  async function token(clientId: string, clientSecret: string, scope: UberScope): Promise<string> {
    const key = `${clientId}:${scope}`;
    const cached = tokens.get(key);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > now().getTime()) return cached.value;
    let inFlight = pending.get(key);
    if (!inFlight) {
      inFlight = fetchToken(clientId, clientSecret, scope).finally(() => pending.delete(key));
      pending.set(key, inFlight);
    }
    return inFlight;
  }

  return {
    customerId: () => keys().customerId,
    async request(scope: UberScope, method: "GET" | "POST", path: string, body?: Json): Promise<Json> {
      const { clientId, clientSecret } = keys();
      const bearer = await token(clientId, clientSecret, scope);
      const { res, json } = await send(
        doFetch,
        `${API_URL}${path}`,
        {
          method,
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        },
        `${method} ${path}`,
      );
      // Error body: { code, message, kind: "error", metadata? } (Uber Direct sandbox, 2026-11-13).
      if (!res.ok) {
        if (res.status === 401) tokens.delete(`${clientId}:${scope}`);
        throw new DeliveryProviderError(
          "uber",
          res.status,
          typeof json.code === "string" ? json.code : "unknown",
          `Uber Direct ${method} ${path} failed with ${res.status}: ${typeof json.message === "string" ? json.message : "no message"}`,
        );
      }
      return json;
    },
  };
}

export type UberDirectClient = ReturnType<typeof createUberDirectClient>;

/** Uber takes a JSON-encoded address string: https://developer.uber.com/docs/deliveries/get-started */
export function uberAddress(address: DeliveryAddress): string {
  return JSON.stringify({
    street_address: [address.line1, address.line2 ?? ""],
    city: address.city,
    state: address.state,
    zip_code: address.zip,
    country: "US",
  });
}

function requiredDate(value: unknown, field: string): Date {
  const date = typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new Error(`Uber Direct returned an invalid ${field}`);
  return date;
}

function optionalDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function feeCents(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error("Uber Direct returned an invalid fee");
  return value as number;
}

/** The webhook's x-uber-signature is missing or does not match the body. */
export class UberWebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UberWebhookSignatureError";
  }
}

// Delivery status values: https://developer.uber.com/docs/deliveries/daas/references/api/webhooks/delivery-status-webhook
// pending, dropoff and returned carry no platform step; returned follows a failed dropoff and is handled with the order flow (#136).
const EVENT_TYPES: Record<string, CourierEventType> = {
  pickup: "courier_assigned",
  pickup_complete: "picked_up",
  delivered: "delivered",
  canceled: "cancelled",
};

export class UberDirectProvider implements DeliveryProvider {
  readonly name = "uber" as const;
  private readonly client: UberDirectClient;
  private readonly env: Record<string, string | undefined>;

  constructor(opts: UberDirectOptions = {}) {
    this.client = createUberDirectClient(opts);
    this.env = opts.env ?? process.env;
  }

  private path(suffix: string): string {
    return `/v1/customers/${encodeURIComponent(this.client.customerId())}${suffix}`;
  }

  /** POST /v1/customers/{customer_id}/delivery_quotes: https://developer.uber.com/docs/deliveries/get-started */
  async quote(req: DeliveryRequest): Promise<DeliveryQuote> {
    const res = await this.client.request("eats.deliveries", "POST", this.path("/delivery_quotes"), {
      pickup_address: uberAddress(req.pickup.address),
      dropoff_address: uberAddress(req.dropoff.address),
      pickup_phone_number: req.pickup.phone,
      dropoff_phone_number: req.dropoff.phone,
      manifest_total_value: req.orderValueCents,
      external_store_id: req.pickup.providerStoreId,
    });
    const created = requiredDate(res.created, "created");
    return {
      quoteId: String(res.id),
      feeCents: feeCents(res.fee),
      currency: typeof res.currency === "string" ? res.currency.toUpperCase() : "USD",
      pickupEta: typeof res.pickup_duration === "number" ? new Date(created.getTime() + res.pickup_duration * 60_000) : null,
      dropoffEta: optionalDate(res.dropoff_eta),
      expiresAt: requiredDate(res.expires, "expires"),
    };
  }

  /**
   * POST /v1/customers/{customer_id}/deliveries books the quoted delivery: https://developer.uber.com/docs/deliveries/get-started
   * Uber requires the names, phones, addresses and at least one manifest item (sandbox, 2026-11-13). Line items
   * reach the courier with the order flow (#136); until then one line stands for the order, sized for a car trunk.
   */
  async create(quoteId: string, req: DeliveryRequest): Promise<CreatedDelivery> {
    const dropoffName = [req.dropoff.givenName, req.dropoff.familyName].filter(Boolean).join(" ");
    const res = await this.client.request("eats.deliveries", "POST", this.path("/deliveries"), {
      quote_id: quoteId,
      external_id: req.externalDeliveryId,
      external_store_id: req.pickup.providerStoreId,
      pickup_name: req.pickup.businessName,
      pickup_address: uberAddress(req.pickup.address),
      pickup_phone_number: req.pickup.phone,
      dropoff_name: dropoffName || "Customer",
      dropoff_address: uberAddress(req.dropoff.address),
      dropoff_phone_number: req.dropoff.phone,
      dropoff_notes: req.dropoff.instructions,
      manifest_items: [{ name: "Grocery order", quantity: 1, size: "large", price: req.orderValueCents }],
      manifest_total_value: req.orderValueCents,
      tip: req.tipCents,
    });
    if (typeof res.id !== "string") throw new Error("Uber Direct returned a delivery without an id");
    return { externalId: res.id, trackingUrl: typeof res.tracking_url === "string" ? res.tracking_url : null };
  }

  /** POST /v1/customers/{customer_id}/deliveries/{delivery_id}/cancel */
  async cancel(externalId: string): Promise<void> {
    await this.client.request("eats.deliveries", "POST", this.path(`/deliveries/${encodeURIComponent(externalId)}/cancel`));
  }

  /**
   * Verifies and parses one webhook. x-uber-signature is the lowercase hex HMAC-SHA256 of the raw body with the
   * webhook's signing key: https://developer.uber.com/docs/deliveries/guides/webhooks
   */
  handleWebhook(raw: string, headers: Headers): DeliveryWebhookEvent {
    const key = this.env.UBER_DIRECT_WEBHOOK_SIGNING_KEY;
    if (!key) throw new Error("Uber Direct webhooks are not configured: missing UBER_DIRECT_WEBHOOK_SIGNING_KEY");
    const given = headers.get("x-uber-signature") ?? "";
    if (!/^[0-9a-f]{64}$/i.test(given)) throw new UberWebhookSignatureError("Missing or malformed x-uber-signature");
    const expected = createHmac("sha256", key).update(raw).digest();
    if (!timingSafeEqual(Buffer.from(given, "hex"), expected)) throw new UberWebhookSignatureError("x-uber-signature does not match the body");

    const body = JSON.parse(raw) as Json;
    const data = (typeof body.data === "object" && body.data !== null ? body.data : {}) as Json;
    const eventId = body.id;
    const externalDeliveryId = body.delivery_id;
    const occurredAt = optionalDate(body.created);
    if (typeof eventId !== "string" || typeof externalDeliveryId !== "string" || !occurredAt) {
      throw new Error("Uber Direct webhook is missing id, delivery_id or created");
    }
    const type = body.kind === "event.delivery_status" && typeof body.status === "string" ? EVENT_TYPES[body.status] ?? null : null;
    const courier = (typeof data.courier === "object" && data.courier !== null ? data.courier : null) as Json | null;
    const text = (value: unknown) => (typeof value === "string" && value ? value : null);
    const vehicle = courier ? [courier.vehicle_make, courier.vehicle_model].map(text).filter(Boolean).join(" ") || text(courier.vehicle_type) : null;
    return {
      provider: "uber",
      externalDeliveryId,
      externalEventId: eventId,
      type,
      occurredAt,
      trackingUrl: text(data.tracking_url),
      actualFeeCents: type === "delivered" && data.fee !== undefined ? feeCents(data.fee) : null,
      courier: courier ? { name: text(courier.name), vehicle, dropoffEta: optionalDate(data.dropoff_eta) } : null,
      payload: body,
    };
  }
}
