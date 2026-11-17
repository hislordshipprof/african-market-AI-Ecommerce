/**
 * Test double for Shippo's POST /shipments, /transactions and /refunds, used when SHIPPO_API_KEY is not set
 * (decision 2026-11-14-05). It refuses what Shippo refuses: a missing or wrong ShippoToken (401), missing address or
 * parcel fields, an unknown unit or a non-positive weight (400), and returns no rates unless async is false.
 * A label is bought only from a rate it quoted less than 7 days ago [ASSUMPTION: Shippo does not document the error
 * for an older rate; the fake answers ERROR]; a rate already bought returns the same transaction. A refund after
 * `scan()` is an ERROR, as Shippo rejects a scanned label.
 */
export interface FakeShippoOptions {
  token: string;
  /** Rates per pound added to each base; the cheapest service is USPS Ground Advantage. */
  services?: Array<{ provider: string; name: string; baseCents: number; perLbCents: number; days: number }>;
  now?: () => Date;
}

export const FAKE_LABEL_HOST = "https://shippo-delivery.fake";
/** A minimal one-page PDF, enough for the label route and the PDF check. */
export const FAKE_LABEL_PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const RATE_WINDOW_MS = 7 * 24 * 60 * 60_000;

export type FakeShippo = typeof fetch & {
  calls: Json[];
  /** The carrier scans the label: a refund is refused from now on. */
  scan(labelId: string): void;
  /** Every rate quoted, with its fee in cents; a test can age or reprice what checkout locked. */
  rates: Map<string, { quotedAt: Date; feeCents: number }>;
  labels: Map<string, { rateId: string; scanned: boolean; refunded: boolean }>;
};

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

export function fakeShippo(opts: FakeShippoOptions): FakeShippo {
  const services = opts.services ?? DEFAULT_SERVICES;
  const now = opts.now ?? (() => new Date());
  const calls: Json[] = [];
  const rates = new Map<string, { quotedAt: Date; feeCents: number }>();
  const labels = new Map<string, { rateId: string; scanned: boolean; refunded: boolean }>();
  let shipments = 0;
  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    if (url.origin === FAKE_LABEL_HOST) {
      const id = url.pathname.replace(/^\/labels\/|\.pdf$/g, "");
      return labels.has(id) ? new Response(FAKE_LABEL_PDF, { headers: { "content-type": "application/pdf" } }) : new Response(null, { status: 404 });
    }
    if (!headers.get("authorization")) return reply(401, { detail: "Authentication credentials were not provided." });
    if (headers.get("authorization") !== `ShippoToken ${opts.token}`) return reply(401, { detail: "Token does not exist" });
    if (init?.method !== "POST" || !["/shipments/", "/transactions/", "/refunds/"].includes(url.pathname)) return reply(404, { detail: "Not found." });
    let body: Json;
    try {
      body = JSON.parse(String(init.body)) as Json;
    } catch {
      return reply(400, { detail: "JSON parse error" });
    }
    calls.push(body);
    if (url.pathname === "/transactions/") return transaction(body);
    if (url.pathname === "/refunds/") return refund(body);
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
    const quoted = services.map((service, i) => ({
      object_id: `rate_fake_${shipments}_${i}`,
      shipment: shipmentId,
      amount: ((service.baseCents + Math.ceil(lb) * service.perLbCents) / 100).toFixed(2),
      currency: "USD",
      provider: service.provider,
      servicelevel: { name: service.name, token: `${service.provider}_${service.name}`.toLowerCase().replace(/\W+/g, "_") },
      estimated_days: service.days,
      attributes: [],
    }));
    for (const rate of quoted) rates.set(rate.object_id, { quotedAt: now(), feeCents: Math.round(Number(rate.amount) * 100) });
    return reply(201, { object_id: shipmentId, status: "SUCCESS", rates: quoted, messages: [] });
  };

  function transaction(body: Json): Response {
    if (typeof body.rate !== "string" || !body.rate) return reply(400, { rate: ["This field is required."] });
    const rate = rates.get(body.rate);
    if (!rate) return reply(400, { rate: ["Invalid pk - object does not exist."] });
    const existing = [...labels.entries()].find(([, label]) => label.rateId === body.rate);
    // Shippo object ids are unique across the account, so two fakes never share one.
    const id = existing?.[0] ?? `txn_fake_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    if (!existing) {
      if (now().getTime() - rate.quotedAt.getTime() >= RATE_WINDOW_MS) {
        return reply(201, { object_id: `txn_fake_err_${labels.size + 1}`, status: "ERROR", messages: [{ text: "Rate has expired. Please create a new shipment." }] });
      }
      labels.set(id, { rateId: body.rate, scanned: false, refunded: false });
    }
    return reply(201, {
      object_id: id,
      status: "SUCCESS",
      rate: body.rate,
      tracking_number: trackingNumber(id),
      tracking_url_provider: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber(id)}`,
      label_url: `${FAKE_LABEL_HOST}/labels/${id}.pdf`,
      messages: [],
    });
  }

  function trackingNumber(id: string): string {
    return `9400${[...id].map((c) => c.charCodeAt(0) % 10).join("").slice(-18).padStart(18, "0")}`;
  }

  function refund(body: Json): Response {
    const label = typeof body.transaction === "string" ? labels.get(body.transaction) : undefined;
    if (!label) return reply(400, { transaction: ["Invalid pk - object does not exist."] });
    if (label.scanned) return reply(201, { object_id: `ref_${body.transaction}`, transaction: body.transaction, status: "ERROR" });
    label.refunded = true;
    return reply(201, { object_id: `ref_${body.transaction}`, transaction: body.transaction, status: "QUEUED" });
  }

  const scan = (labelId: string) => {
    const label = labels.get(labelId);
    if (label) label.scanned = true;
  };
  return Object.assign(handler as typeof fetch, { calls, scan, rates, labels });
}
