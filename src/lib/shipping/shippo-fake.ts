/**
 * Test double for Shippo's POST /shipments, used when SHIPPO_API_KEY is not set (decision 2026-11-14-05).
 * It refuses what Shippo refuses: a missing or wrong ShippoToken (401), missing address or parcel
 * fields, an unknown unit or a non-positive weight (400), and returns no rates unless async is false.
 */
export interface FakeShippoOptions {
  token: string;
  /** Rates per pound added to each base; the cheapest service is USPS Ground Advantage. */
  services?: Array<{ provider: string; name: string; baseCents: number; perLbCents: number; days: number }>;
}

type Json = Record<string, unknown>;

const DEFAULT_SERVICES = [
  { provider: "USPS", name: "Ground Advantage", baseCents: 545, perLbCents: 95, days: 5 },
  { provider: "USPS", name: "Priority Mail", baseCents: 895, perLbCents: 120, days: 3 },
  { provider: "UPS", name: "Ground", baseCents: 1050, perLbCents: 85, days: 4 },
];
const DISTANCE_UNITS = ["cm", "in", "ft", "mm", "m", "yd"];
const MASS_UNITS = ["g", "oz", "lb", "kg"];
const LB_PER_UNIT: Record<string, number> = { g: 1 / 453.59237, oz: 1 / 16, lb: 1, kg: 2.20462262 };

function reply(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function addressErrors(address: unknown): Record<string, string[]> | null {
  if (!address || typeof address !== "object") return { __all__: ["This field is required."] };
  const a = address as Json;
  const errors: Record<string, string[]> = {};
  for (const field of ["name", "street1", "city", "zip", "country"]) {
    if (typeof a[field] !== "string" || !(a[field] as string).trim()) errors[field] = ["This field is required."];
  }
  if (a.country === "US") {
    if (typeof a.state !== "string" || !/^[A-Z]{2}$/.test(a.state)) errors.state = ["A valid US state is required."];
    if (typeof a.zip === "string" && !/^\d{5}(-\d{4})?$/.test(a.zip)) errors.zip = ["Enter a valid US ZIP code."];
  }
  return Object.keys(errors).length ? errors : null;
}

function parcelErrors(parcels: unknown): Json | null {
  if (!Array.isArray(parcels) || parcels.length === 0) return { parcels: ["This field is required."] };
  const errors: Json[] = [];
  for (const parcel of parcels as Json[]) {
    const e: Record<string, string[]> = {};
    for (const field of ["length", "width", "height"]) {
      if (!(Number(parcel[field]) > 0)) e[field] = ["Must be a positive number."];
    }
    if (!DISTANCE_UNITS.includes(parcel.distance_unit as string)) e.distance_unit = ["Not a valid choice."];
    if (!MASS_UNITS.includes(parcel.mass_unit as string)) e.mass_unit = ["Not a valid choice."];
    if (!(Number(parcel.weight) > 0)) e.weight = ["Must be a positive number."];
    if (Object.keys(e).length) errors.push(e);
  }
  return errors.length ? { parcels: errors } : null;
}

export function fakeShippo(opts: FakeShippoOptions): typeof fetch & { calls: Json[] } {
  const services = opts.services ?? DEFAULT_SERVICES;
  const calls: Json[] = [];
  let shipments = 0;
  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    if (!headers.get("authorization")) return reply(401, { detail: "Authentication credentials were not provided." });
    if (headers.get("authorization") !== `ShippoToken ${opts.token}`) return reply(401, { detail: "Token does not exist" });
    if (init?.method !== "POST" || url.pathname !== "/shipments/") return reply(404, { detail: "Not found." });
    let body: Json;
    try {
      body = JSON.parse(String(init.body)) as Json;
    } catch {
      return reply(400, { detail: "JSON parse error" });
    }
    calls.push(body);
    const errors: Json = {};
    const from = addressErrors(body.address_from);
    const to = addressErrors(body.address_to);
    if (from) errors.address_from = from;
    if (to) errors.address_to = to;
    Object.assign(errors, parcelErrors(body.parcels) ?? {});
    if (Object.keys(errors).length) return reply(400, errors);

    shipments++;
    const shipmentId = `shp_fake_${shipments}`;
    if (body.async !== false) return reply(201, { object_id: shipmentId, status: "QUEUED", rates: [], messages: [] });
    const parcel = (body.parcels as Json[])[0];
    const lb = Number(parcel.weight) * LB_PER_UNIT[parcel.mass_unit as string];
    const rates = services.map((service, i) => ({
      object_id: `rate_fake_${shipments}_${i}`,
      shipment: shipmentId,
      amount: ((service.baseCents + Math.ceil(lb) * service.perLbCents) / 100).toFixed(2),
      currency: "USD",
      provider: service.provider,
      servicelevel: { name: service.name, token: `${service.provider}_${service.name}`.toLowerCase().replace(/\W+/g, "_") },
      estimated_days: service.days,
      attributes: [],
    }));
    return reply(201, { object_id: shipmentId, status: "SUCCESS", rates, messages: [] });
  };
  return Object.assign(handler as typeof fetch, { calls });
}
