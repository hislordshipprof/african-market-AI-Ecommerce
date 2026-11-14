import {
  addressUserAgent,
  CENSUS_MAX_CHARS,
  CENSUS_TIMEOUT_MS,
  censusOneline,
  PHOTON_TIMEOUT_MS,
  storeBbox,
  type AddressParts,
  type Geocode,
  type StorePoint,
  type Suggestion,
} from "./geo";

export type LocateResult =
  | { ok: true; match: Geocode }
  | { ok: false; code: "no-match" | "ambiguous" | "unavailable" | "rejected" };

interface PhotonFeature {
  geometry?: { coordinates?: number[] };
  properties?: {
    housenumber?: string;
    street?: string;
    city?: string;
    state?: string;
    postcode?: string;
    countrycode?: string;
  };
}

function samePoint(a: Geocode, b: Geocode): boolean {
  return Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;
}

export async function suggestFromPhoton(
  query: string,
  store: StorePoint,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Suggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", trimmed);
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycode", "US");
  url.searchParams.set("layer", "house");
  url.searchParams.set("bbox", storeBbox(store));
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(PHOTON_TIMEOUT_MS),
      headers: { Accept: "application/json", "User-Agent": addressUserAgent(env) },
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  let body: { features?: PhotonFeature[] };
  try {
    body = (await response.json()) as { features?: PhotonFeature[] };
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const suggestions: Suggestion[] = [];
  for (const feature of body.features ?? []) {
    const props = feature.properties ?? {};
    if (props.countrycode && props.countrycode !== "US") continue;
    const housenumber = props.housenumber?.trim() ?? "";
    const street = props.street?.trim() ?? "";
    if (!housenumber || !street) continue;
    const city = props.city?.trim() ?? "";
    const state = props.state?.trim() ?? "";
    const zip = props.postcode?.trim() ?? "";
    const key = [housenumber, street, city, state, zip].join("|").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const line1 = `${housenumber} ${street}`;
    const place = [city, state].filter(Boolean).join(", ");
    const label = [line1, place, zip].filter(Boolean).join(", ");
    suggestions.push({ line1, city, state, zip, label });
    if (suggestions.length === 5) break;
  }
  return suggestions;
}

export async function locateWithCensus(
  parts: AddressParts,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocateResult> {
  const oneline = censusOneline(parts);
  if (!parts.line1.trim() || oneline.length > CENSUS_MAX_CHARS) return { ok: false, code: "rejected" };
  let response: Response;
  try {
    const url = new URL("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress");
    url.searchParams.set("address", oneline);
    url.searchParams.set("benchmark", "Public_AR_Current");
    url.searchParams.set("format", "json");
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(CENSUS_TIMEOUT_MS),
      headers: { Accept: "application/json", "User-Agent": addressUserAgent(env) },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "census_geocode_failed",
      status: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network",
    }));
    return { ok: false, code: "unavailable" };
  }
  if (response.status === 400) return { ok: false, code: "rejected" };
  if (!response.ok) {
    console.error(JSON.stringify({ event: "census_geocode_failed", status: response.status }));
    return { ok: false, code: "unavailable" };
  }
  let body: {
    result?: {
      addressMatches?: Array<{
        matchedAddress?: string;
        coordinates?: { x?: number; y?: number };
        addressComponents?: { city?: string; state?: string; zip?: string };
      }>;
    };
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    console.error(JSON.stringify({ event: "census_geocode_failed", status: "invalid-json" }));
    return { ok: false, code: "unavailable" };
  }
  const matches = body.result?.addressMatches ?? [];
  const geocodes: Geocode[] = [];
  for (const match of matches) {
    const lng = match.coordinates?.x;
    const lat = match.coordinates?.y;
    if (typeof lng !== "number" || typeof lat !== "number") continue;
    const formatted = match.matchedAddress?.trim() || oneline;
    const line1 = formatted.split(",")[0]?.trim() || parts.line1.trim();
    const components = match.addressComponents ?? {};
    geocodes.push({
      line1,
      city: (components.city || parts.city).trim(),
      state: (components.state || parts.state).trim(),
      zip: (components.zip || parts.zip).trim(),
      formattedAddress: formatted,
      lat,
      lng,
    });
  }
  if (geocodes.length === 0) return { ok: false, code: "no-match" };
  const first = geocodes[0];
  if (geocodes.some((item) => !samePoint(item, first))) return { ok: false, code: "ambiguous" };
  return { ok: true, match: first };
}
