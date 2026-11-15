import {
  addressCacheKey,
  CENSUS_MAX_CHARS,
  censusOneline,
  type AddressParts,
  type Geocode,
  type Suggestion,
} from "./geo";
import type { LocateResult } from "./remote";

/**
 * Addresses the e2e fake confirms. Coordinates are Census matches from
 * 2026-11-08. 3700 Main St is 7.5 mi from the seeded Park Place store.
 */
const KNOWN: Geocode[] = [
  {
    line1: "4600 SILVER HILL RD",
    city: "WASHINGTON",
    state: "DC",
    zip: "20233",
    formattedAddress: "4600 SILVER HILL RD, WASHINGTON, DC, 20233",
    lat: 38.84505589808,
    lng: -76.92836638093,
  },
  {
    line1: "1600 PENNSYLVANIA AVE NW",
    city: "WASHINGTON",
    state: "DC",
    zip: "20500",
    formattedAddress: "1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500",
    lat: 38.898702605245,
    lng: -77.035189204737,
  },
  {
    line1: "8505 FENTON ST",
    city: "SILVER SPRING",
    state: "MD",
    zip: "20910",
    formattedAddress: "8505 FENTON ST, SILVER SPRING, MD, 20910",
    lat: 38.996293163535,
    lng: -77.024773544996,
  },
  {
    line1: "8400 PARK PLACE BLVD",
    city: "HOUSTON",
    state: "TX",
    zip: "77017",
    formattedAddress: "8400 PARK PLACE BLVD, HOUSTON, TX, 77017",
    lat: 29.693857800118,
    lng: -95.266257879374,
  },
  {
    line1: "3700 MAIN ST",
    city: "HOUSTON",
    state: "TX",
    zip: "77002",
    formattedAddress: "3700 MAIN ST, HOUSTON, TX, 77002",
    lat: 29.73846459154,
    lng: -95.379640065998,
  },
];

function knownKey(match: Geocode): string {
  return addressCacheKey({
    line1: match.line1,
    city: match.city,
    state: match.state,
    zip: match.zip,
  });
}

const BY_KEY = new Map(KNOWN.map((match) => [knownKey(match), match]));

export function fakeLocate(parts: AddressParts): LocateResult {
  const oneline = censusOneline(parts);
  if (!parts.line1.trim() || oneline.length > CENSUS_MAX_CHARS) return { ok: false, code: "rejected" };
  const match = BY_KEY.get(addressCacheKey(parts));
  if (!match) return { ok: false, code: "no-match" };
  return { ok: true, match };
}

export function fakeSuggest(query: string): Suggestion[] {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];
  const needle = trimmed.toLowerCase();
  return KNOWN.filter((match) => match.line1.toLowerCase().includes(needle) || match.formattedAddress.toLowerCase().includes(needle))
    .slice(0, 5)
    .map((match) => ({
      line1: match.line1,
      city: match.city,
      state: match.state,
      zip: match.zip,
      label: match.formattedAddress,
    }));
}

export function fakeKnown(): readonly Geocode[] {
  return KNOWN;
}
