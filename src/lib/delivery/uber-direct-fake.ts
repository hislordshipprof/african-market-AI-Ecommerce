import { randomUUID } from "node:crypto";

/**
 * Test double for the Uber Direct API. It enforces the rules a fake that accepts anything would hide:
 * client-credentials tokens per scope with expiry (https://developer.uber.com/docs/deliveries/guides/authentication),
 * the customer id in the path, JSON-string addresses, the required create fields, and 404/409 on unknown or
 * repeated ids. Error bodies, required fields and the Organizations rules mirror the Uber Direct sandbox's own
 * responses (checked 2026-11-13).
 */
export interface FakeUberDirectOptions {
  clientId: string;
  clientSecret: string;
  customerId: string;
  now: () => Date;
  quoteFeeCents?: number;
  tokenTtlSeconds?: number;
}

type Json = Record<string, unknown>;

const ADDRESS_KEYS = ["street_address", "city", "state", "zip_code", "country"];
const CREATE_REQUIRED = ["pickup_name", "pickup_address", "pickup_phone_number", "dropoff_name", "dropoff_address", "dropoff_phone_number"];

function reply(status: number, body: Json) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function invalid(metadata: Json) {
  return reply(400, { code: "invalid_params", message: "The parameters of your request were invalid.", kind: "error", metadata });
}

function isAddress(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const address = JSON.parse(value) as Json;
    return ADDRESS_KEYS.every((key) => key in address) && Array.isArray(address.street_address);
  } catch {
    return false;
  }
}

export function fakeUberDirect(opts: FakeUberDirectOptions) {
  const tokens = new Map<string, { scope: string; expiresAt: number }>();
  const quotes = new Map<string, { expires: Date; body: Json }>();
  const deliveries = new Map<string, { status: string; quoteId: string }>();
  const organizations: Json[] = [];
  const calls: Array<{ method: string; path: string; body: Json | null }> = [];
  let tokenRequests = 0;

  function grant(form: URLSearchParams) {
    tokenRequests += 1;
    if (form.get("grant_type") !== "client_credentials") return reply(400, { error: "unsupported_grant_type" });
    if (form.get("client_id") !== opts.clientId || form.get("client_secret") !== opts.clientSecret) {
      return reply(401, { error: "invalid_client" });
    }
    const scope = form.get("scope") ?? "";
    if (scope !== "eats.deliveries" && scope !== "direct.organizations") return reply(400, { error: "invalid_scope" });
    const ttl = opts.tokenTtlSeconds ?? 2_592_000;
    const token = `tok_${randomUUID()}`;
    tokens.set(token, { scope, expiresAt: opts.now().getTime() + ttl * 1000 });
    return reply(200, { access_token: token, token_type: "Bearer", expires_in: ttl, scope });
  }

  function authorize(header: string | null, scope: string): Response | null {
    const token = header?.startsWith("Bearer ") ? tokens.get(header.slice(7)) : undefined;
    if (!token || token.scope !== scope || token.expiresAt <= opts.now().getTime()) {
      return reply(401, { code: "unauthorized", message: "Invalid OAuth 2.0 credentials provided." });
    }
    return null;
  }

  function delivery(id: string, status: string, quoteId: string) {
    return {
      kind: "delivery",
      id,
      quote_id: quoteId,
      status,
      complete: status === "canceled",
      fee: opts.quoteFeeCents ?? 799,
      currency: "usd",
      tracking_url: `https://www.ubereats.com/orders/${id}`,
      live_mode: false,
      created: opts.now().toISOString(),
    };
  }

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    if (url.origin === "https://auth.uber.com" && url.pathname === "/oauth/v2/token" && method === "POST") {
      calls.push({ method, path: url.pathname, body: null });
      return grant(new URLSearchParams(String(init?.body ?? "")));
    }
    if (url.origin !== "https://api.uber.com") return reply(404, { code: "not_found", message: "host" });
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : null;
    calls.push({ method, path: url.pathname, body });
    const headers = new Headers(init?.headers);
    const path = url.pathname;

    if (method === "POST" && path === "/v1/direct/organizations") {
      const denied = authorize(headers.get("authorization"), "direct.organizations");
      if (denied) return denied;
      const info = (body?.info ?? {}) as Json;
      const hierarchy = (body?.hierarchy_info ?? {}) as Json;
      if (hierarchy.parent_organization_id !== opts.customerId) return reply(400, { message: "parent_organization_id is invalid" });
      if (typeof info.name !== "string" || !info.name) return reply(400, { message: "name is invalid" });
      if (info.billing_type !== "BILLING_TYPE_CENTRALIZED") return reply(400, { message: "billing_type is invalid" });
      const organization = { organization_id: randomUUID(), info, hierarchy_info: hierarchy };
      organizations.push(organization);
      return reply(200, organization);
    }

    const denied = authorize(headers.get("authorization"), "eats.deliveries");
    if (denied) return denied;
    const prefix = `/v1/customers/${opts.customerId}`;
    if (!path.startsWith(`${prefix}/`)) {
      return reply(403, { code: "customer_blocked", message: "user is not authorized for this action for given organization", kind: "error" });
    }
    const rest = path.slice(prefix.length);
    let m: RegExpMatchArray | null;

    if (method === "POST" && rest === "/delivery_quotes") {
      const metadata: Json = {};
      if (!isAddress(body?.pickup_address)) metadata.pickup_address = "This field is required.";
      if (!isAddress(body?.dropoff_address)) metadata.dropoff_address = "This field is required.";
      if (Object.keys(metadata).length) return invalid(metadata);
      const created = opts.now();
      const id = `dqt_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
      const expires = new Date(created.getTime() + 15 * 60_000);
      quotes.set(id, { expires, body: body! });
      return reply(200, {
        kind: "delivery_quote",
        id,
        created: created.toISOString(),
        expires: expires.toISOString(),
        fee: opts.quoteFeeCents ?? 799,
        currency: "usd",
        currency_type: "USD",
        dropoff_eta: new Date(created.getTime() + 55 * 60_000).toISOString(),
        duration: 55,
        pickup_duration: 12,
        external_store_id: body?.external_store_id ?? null,
        dropoff_deadline: new Date(created.getTime() + 66 * 60_000).toISOString(),
        warnings: null,
      });
    }
    if (method === "POST" && rest === "/deliveries") {
      const metadata: Json = {};
      for (const key of CREATE_REQUIRED) if (!body?.[key]) metadata[key] = "This field is required.";
      for (const key of ["pickup_address", "dropoff_address"]) if (body?.[key] && !isAddress(body[key])) metadata[key] = "This field is invalid.";
      const items = body?.manifest_items;
      if (!Array.isArray(items) || items.length === 0 || items.some((item: Json) => !item.name || !Number.isInteger(item.quantity))) {
        metadata.manifest = "Please provide at least one manifest item description";
      }
      if (Object.keys(metadata).length) return invalid(metadata);
      const quoteId = String(body!.quote_id ?? "");
      const quote = quotes.get(quoteId);
      if (!quote) return reply(404, { code: "not_found", message: "The requested quote does not exist.", kind: "error" });
      if (quote.expires <= opts.now()) return reply(400, { code: "expired_quote", message: "The quote has expired.", kind: "error" });
      if ([...deliveries.values()].some((d) => d.quoteId === quoteId)) {
        return reply(409, { code: "duplicate_delivery", message: "A delivery already exists for this quote.", kind: "error" });
      }
      const id = `del_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
      deliveries.set(id, { status: "pending", quoteId });
      const pincode = ((body!.dropoff_verification as Json | undefined)?.pincode as Json | undefined)?.enabled === true;
      const created = delivery(id, "pending", quoteId);
      return reply(200, pincode ? { ...created, dropoff: { verification_requirements: { pincode: { enabled: true, value: "6066" } } } } : created);
    }
    if (method === "POST" && (m = rest.match(/^\/deliveries\/([^/]+)\/cancel$/))) {
      const found = deliveries.get(m[1]);
      if (!found) return reply(404, { code: "delivery_not_found", message: "The requested delivery does not exist.", kind: "error" });
      if (found.status === "canceled") {
        return reply(409, { code: "noncancelable_delivery", message: "Delivery cannot be canceled.", kind: "error" });
      }
      found.status = "canceled";
      return reply(200, delivery(m[1], "canceled", found.quoteId));
    }
    return reply(404, { code: "not_found", message: `${method} ${path}`, kind: "error" });
  };

  return {
    fetch,
    calls,
    organizations,
    get tokenRequests() {
      return tokenRequests;
    },
  };
}
