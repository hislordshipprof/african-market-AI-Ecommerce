import { STATE_NAMES, isStateCode, type StateCode } from "./us-states";

export type NearQuery =
  | { kind: "zip"; zip: string }
  | { kind: "city"; key: string; state: StateCode | null };

const MAX_QUERY = 80;

/** The lookup key a place name is stored and searched under: lower case, no accents or punctuation, Saint as St, Ft as Fort, Mt as Mount. */
export function placeKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/(^| )saint /g, "$1st ")
    .replace(/(^| )ft /g, "$1fort ")
    .replace(/(^| )mt /g, "$1mount ");
}

const TYPE_SUFFIX =
  / (city and borough|city|town|village|CDP|borough|municipality|corporation|unified government|consolidated government|metropolitan government|metro government|urban county|comunidad|zona urbana)$/;
// Census "consolidated" places (LSAD 00, UG, UC, MG, CG) such as "Nashville-Davidson".
const CONSOLIDATED = new Set(["00", "UG", "UC", "MG", "CG"]);

/** The name people type for a Gazetteer place row, e.g. "Nashville" for "Nashville-Davidson metropolitan government (balance)". */
export function gazetteerPlaceName(name: string, lsad: string): string {
  let plain = name.replace(/ \(balance\)$/, "").replace(TYPE_SUFFIX, "");
  if (CONSOLIDATED.has(lsad)) plain = plain.split(/[-/,]/)[0]!.trim();
  return plain;
}

const STATE_BY_NAME = new Map(Object.entries(STATE_NAMES).map(([code, name]) => [placeKey(name), code as StateCode]));

function stateFrom(text: string): StateCode | null {
  const upper = text.trim().toUpperCase();
  if (isStateCode(upper)) return upper;
  return STATE_BY_NAME.get(placeKey(text)) ?? null;
}

/** A ZIP (ZIP+4 allowed) or a city with an optional state; null when it is neither. */
export function parseNearQuery(raw: string): NearQuery | null {
  const text = raw.trim();
  if (!text || text.length > MAX_QUERY) return null;
  const zip = /^(\d{5})(-\d{4})?$/.exec(text);
  if (zip) return { kind: "zip", zip: zip[1]! };
  if (/^\d+$/.test(text)) return null;

  let city = text;
  let state: StateCode | null = null;
  const comma = text.lastIndexOf(",");
  if (comma > 0) {
    state = stateFrom(text.slice(comma + 1));
    if (state) city = text.slice(0, comma);
  } else {
    const lastSpace = text.lastIndexOf(" ");
    const tail = lastSpace > 0 ? text.slice(lastSpace + 1) : "";
    if (tail.length === 2 && isStateCode(tail.toUpperCase())) {
      state = tail.toUpperCase() as StateCode;
      city = text.slice(0, lastSpace);
    }
  }
  const key = placeKey(city);
  return key ? { kind: "city", key, state } : null;
}
