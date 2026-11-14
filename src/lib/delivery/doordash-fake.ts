import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Test double for the DoorDash Drive API. It enforces the documented rules a fake that accepts
 * anything would hide: the JWT (https://developer.doordash.com/en-US/docs/drive/reference/JWTs),
 * required fields and id formats, and 404/409 on unknown or repeated ids
 * (https://developer.doordash.com/en-US/api/drive/).
 */
export interface FakeDoorDashOptions {
  developerId: string;
  keyId: string;
  signingSecret: string;
  now: () => Date;
  quoteFeeCents?: number;
}

const ID = /^[a-zA-Z0-9-._~]+$/;
const BUSINESS_ID = /^[A-Za-z0-9_-]{3,64}$/;
const E164 = /^\+[1-9]\d{6,14}$/;

type Json = Record<string, unknown>;

export function fakeDoorDash(opts: FakeDoorDashOptions) {
  const quotes = new Map<string, { body: Json; at: Date; accepted: boolean }>();
  const cancelled = new Set<string>();
  const businesses = new Map<string, Json>();
  const stores = new Map<string, Json>();
  const calls: Array<{ method: string; path: string; body: Json | null }> = [];

  function reply(status: number, body: Json) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  function jwtError(auth: string | null): string | null {
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return "missing bearer token";
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return "malformed token";
    const expected = createHmac("sha256", Buffer.from(opts.signingSecret, "base64url")).update(`${h}.${p}`).digest();
    const given = Buffer.from(s, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "bad signature";
    const header = JSON.parse(Buffer.from(h, "base64url").toString()) as Json;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Json;
    if (header.alg !== "HS256" || header["dd-ver"] !== "DD-JWT-V1") return "bad header";
    if (claims.aud !== "doordash" || claims.iss !== opts.developerId || claims.kid !== opts.keyId) return "bad claims";
    const now = Math.floor(opts.now().getTime() / 1000);
    const iat = Number(claims.iat);
    const exp = Number(claims.exp);
    if (!(iat <= now) || !(exp > now) || exp - iat > 1800) return "expired or too long";
    return null;
  }

  function delivery(id: string, body: Json, status: string) {
    return {
      external_delivery_id: id,
      currency: "USD",
      fee: opts.quoteFeeCents ?? 850,
      order_value: body.order_value,
      delivery_status: status,
      pickup_time_estimated: new Date(opts.now().getTime() + 20 * 60_000).toISOString(),
      dropoff_time_estimated: new Date(opts.now().getTime() + 45 * 60_000).toISOString(),
      support_reference: "86313",
      tracking_url: `https://doordash.com/tracking?id=${id}`,
      updated_at: opts.now().toISOString(),
    };
  }

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== "https://openapi.doordash.com") return reply(404, { code: "not_found", message: "host" });
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : null;
    calls.push({ method, path: url.pathname, body });
    const authError = jwtError(new Headers(init?.headers).get("authorization"));
    if (authError) return reply(401, { code: "authentication_error", message: authError });

    const path = url.pathname;
    let m: RegExpMatchArray | null;
    if (method === "POST" && path === "/drive/v2/quotes") {
      const id = String(body?.external_delivery_id ?? "");
      const fieldErrors = [
        !ID.test(id) && { field: "external_delivery_id", error: "invalid" },
        typeof body?.dropoff_address !== "string" && { field: "dropoff_address", error: "required" },
        typeof body?.dropoff_phone_number === "string" && !E164.test(body.dropoff_phone_number) && { field: "dropoff_phone_number", error: "invalid" },
        !Number.isInteger(body?.order_value) && { field: "order_value", error: "invalid" },
      ].filter(Boolean);
      if (fieldErrors.length) return reply(400, { code: "validation_error", message: "Validation Failed", field_errors: fieldErrors });
      if (quotes.has(id)) return reply(409, { code: "duplicate_delivery_id", message: "duplicate" });
      quotes.set(id, { body: body!, at: opts.now(), accepted: false });
      return reply(200, delivery(id, body!, "quote"));
    }
    if (method === "POST" && (m = path.match(/^\/drive\/v2\/quotes\/([^/]+)\/accept$/))) {
      const quote = quotes.get(m[1]);
      if (!quote) return reply(404, { code: "not_found", message: "unknown delivery" });
      if (quote.accepted) return reply(409, { code: "duplicate_delivery_id", message: "already accepted" });
      quote.accepted = true;
      return reply(200, delivery(m[1], quote.body, "created"));
    }
    if (method === "PUT" && (m = path.match(/^\/drive\/v2\/deliveries\/([^/]+)\/cancel$/))) {
      const quote = quotes.get(m[1]);
      if (!quote?.accepted) return reply(404, { code: "not_found", message: "unknown delivery" });
      if (cancelled.has(m[1])) return reply(409, { code: "cannot_be_cancelled", message: "already cancelled" });
      cancelled.add(m[1]);
      return reply(200, delivery(m[1], quote.body, "cancelled"));
    }
    if ((m = path.match(/^\/developer\/v1\/businesses\/([^/]+)$/)) && method === "GET") {
      const business = businesses.get(m[1]);
      return business ? reply(200, business) : reply(404, { code: "not_found", message: "unknown business" });
    }
    if (method === "POST" && path === "/developer/v1/businesses") {
      const id = String(body?.external_business_id ?? "");
      if (!BUSINESS_ID.test(id) || id === "default" || !body?.name) return reply(400, { code: "validation_error", message: "Validation Failed" });
      if (businesses.has(id)) return reply(409, { code: "duplicate", message: "business exists" });
      const business = { external_business_id: id, name: body.name, activation_status: "active", is_test: true };
      businesses.set(id, business);
      return reply(200, business);
    }
    if ((m = path.match(/^\/developer\/v1\/businesses\/([^/]+)\/stores\/([^/]+)$/)) && method === "GET") {
      const store = stores.get(`${m[1]}/${m[2]}`);
      return store ? reply(200, store) : reply(404, { code: "not_found", message: "unknown store" });
    }
    if (method === "POST" && (m = path.match(/^\/developer\/v1\/businesses\/([^/]+)\/stores$/))) {
      if (!businesses.has(m[1])) return reply(404, { code: "not_found", message: "unknown business" });
      const id = String(body?.external_store_id ?? "");
      if (!BUSINESS_ID.test(id) || !body?.name || typeof body.address !== "string") {
        return reply(400, { code: "validation_error", message: "Validation Failed" });
      }
      if (stores.has(`${m[1]}/${id}`)) return reply(409, { code: "duplicate", message: "store exists" });
      const store = { external_business_id: m[1], external_store_id: id, name: body.name, address: body.address, status: "active", is_test: true };
      stores.set(`${m[1]}/${id}`, store);
      return reply(200, store);
    }
    return reply(404, { code: "not_found", message: `${method} ${path}` });
  };

  return { fetch, calls };
}
