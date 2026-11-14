/** Earth radius used for the straight-line delivery check, in miles. */
export const EARTH_RADIUS_MI = 3958.8;
export const PHOTON_TIMEOUT_MS = 1_500;
export const CENSUS_TIMEOUT_MS = 5_000;
export const CENSUS_MAX_CHARS = 100;
export const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface AddressParts {
  line1: string;
  city: string;
  state: string;
  zip: string;
}

export interface Geocode {
  line1: string;
  city: string;
  state: string;
  zip: string;
  formattedAddress: string;
  lat: number;
  lng: number;
}

export interface StorePoint {
  lat: number;
  lng: number;
  radiusMi: number;
}

export interface Suggestion {
  line1: string;
  city: string;
  state: string;
  zip: string;
  label: string;
}

/** Unicode-NFKC, lower-case, commas and periods become spaces, whitespace collapsed. */
export function addressCacheKey(parts: AddressParts): string {
  return `${parts.line1} ${parts.city} ${parts.state} ${parts.zip}`
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function censusOneline(parts: AddressParts): string {
  return `${parts.line1.trim()}, ${parts.city.trim()}, ${parts.state.trim()} ${parts.zip.trim()}`
    .replace(/\s+/g, " ")
    .trim();
}

export function addressUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  const root = (env.BETTER_AUTH_URL || "https://localhost").replace(/\/$/, "");
  return `AfricanMarkets/1.0 (+${root})`;
}

export function haversineMiles(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const toRad = Math.PI / 180;
  const dLat = (to.lat - from.lat) * toRad;
  const dLng = (to.lng - from.lng) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(from.lat * toRad) * Math.cos(to.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a));
}

/** Compared unrounded. Stored and shown rounded to 0.1 mi. Equal to the radius is inside. */
export function assessRadius(
  point: { lat: number; lng: number },
  store: StorePoint,
): { distanceMi: number; roundedMi: number; withinRadius: boolean } {
  const distanceMi = haversineMiles(store, point);
  return {
    distanceMi,
    roundedMi: Math.round(distanceMi * 10) / 10,
    withinRadius: distanceMi <= store.radiusMi,
  };
}

/** Photon bbox: minLon,minLat,maxLon,maxLat around the store, in degrees. */
export function storeBbox(store: StorePoint): string {
  const latDelta = store.radiusMi / 69;
  const lngScale = Math.cos((store.lat * Math.PI) / 180);
  const lngDelta = store.radiusMi / (69 * (Math.abs(lngScale) < 0.01 ? 0.01 : lngScale));
  const minLon = store.lng - lngDelta;
  const minLat = store.lat - latDelta;
  const maxLon = store.lng + lngDelta;
  const maxLat = store.lat + latDelta;
  return `${minLon},${minLat},${maxLon},${maxLat}`;
}
