export const VALID_US_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
] as const;
export type USTimezone = (typeof VALID_US_TIMEZONES)[number];

const EASTERN: USTimezone = "America/New_York";
const CENTRAL: USTimezone = "America/Chicago";
const MOUNTAIN: USTimezone = "America/Denver";
const PACIFIC: USTimezone = "America/Los_Angeles";

/** Each state's main zone: the one most of its people use. */
const STATE_ZONE: Record<string, USTimezone> = {
  AL: CENTRAL, AK: "America/Anchorage", AZ: "America/Phoenix", AR: CENTRAL, CA: PACIFIC, CO: MOUNTAIN, CT: EASTERN,
  DE: EASTERN, DC: EASTERN, FL: EASTERN, GA: EASTERN, HI: "Pacific/Honolulu", ID: MOUNTAIN, IL: CENTRAL, IN: EASTERN,
  IA: CENTRAL, KS: CENTRAL, KY: EASTERN, LA: CENTRAL, ME: EASTERN, MD: EASTERN, MA: EASTERN, MI: EASTERN, MN: CENTRAL,
  MS: CENTRAL, MO: CENTRAL, MT: MOUNTAIN, NE: CENTRAL, NV: PACIFIC, NH: EASTERN, NJ: EASTERN, NM: MOUNTAIN, NY: EASTERN,
  NC: EASTERN, ND: CENTRAL, OH: EASTERN, OK: CENTRAL, OR: PACIFIC, PA: EASTERN, RI: EASTERN, SC: EASTERN, SD: CENTRAL,
  TN: CENTRAL, TX: CENTRAL, UT: MOUNTAIN, VT: EASTERN, VA: EASTERN, WA: PACIFIC, WV: EASTERN, WI: CENTRAL, WY: MOUNTAIN,
};

/** A box of a split state that keeps another zone. Bounds are degrees; a missing bound is open. */
type Region = { zone: USTimezone; north?: number; south?: number; west?: number; east?: number };

/**
 * The part of each split state outside its main zone, drawn as one or two boxes around the county lines. Near a line
 * a small town can land on the wrong side; the platform admin corrects it in the store's settings.
 */
const SPLIT_REGIONS: Record<string, Region[]> = {
  TX: [{ zone: MOUNTAIN, east: -104.9 }], // El Paso and Hudspeth counties
  FL: [{ zone: CENTRAL, east: -85.0 }], // west of the Apalachicola River
  TN: [
    { zone: EASTERN, north: 35.3, west: -85.47 }, // Hamilton County and east: Chattanooga
    { zone: EASTERN, south: 35.3, north: 35.75, west: -85.1 }, // Rhea County and east
    { zone: EASTERN, south: 35.75, west: -84.85 }, // Morgan and Scott counties and east: Knoxville
  ],
  KY: [
    { zone: CENTRAL, south: 37.2, east: -85.95 }, // western Kentucky; Louisville and Elizabethtown stay Eastern
    { zone: CENTRAL, north: 37.2, east: -85.0 }, // south-central counties down to Russell and Clinton
  ],
  IN: [
    { zone: CENTRAL, south: 40.73, east: -86.93 }, // Lake, Porter, Jasper and Newton counties
    { zone: CENTRAL, south: 41.15, east: -86.47 }, // LaPorte and Starke counties
    { zone: CENTRAL, north: 38.2, east: -86.5 }, // Posey, Vanderburgh, Warrick, Spencer and Perry counties
    { zone: CENTRAL, north: 38.55, east: -87.4 }, // Gibson County
  ],
  MI: [
    { zone: CENTRAL, north: 46.3, east: -87.5 }, // Menominee, Dickinson and Iron counties
    { zone: CENTRAL, north: 46.6, east: -89.0 }, // Gogebic County
  ],
  ND: [{ zone: MOUNTAIN, north: 47.4, east: -100.82 }], // southwest, across the Missouri River from Bismarck
  SD: [{ zone: MOUNTAIN, east: -101.0 }], // west river counties
  NE: [{ zone: MOUNTAIN, east: -101.3 }], // the panhandle and the western Sandhills
  KS: [{ zone: MOUNTAIN, south: 37.73, east: -101.48 }], // Sherman, Wallace, Greeley and Hamilton counties
  ID: [{ zone: PACIFIC, south: 45.4, east: -114.5 }], // the panhandle, north of the Salmon River
  OR: [{ zone: MOUNTAIN, north: 44.3, west: -118.2 }], // most of Malheur County
};

/**
 * The zone a new store gets from its address (#780): the state's main zone, or for a split state the zone of the box
 * its geocoded point falls in. Without a point the state's main zone is used.
 */
export function timezoneForAddress(state: string, lat: number | null, lng: number | null): USTimezone {
  const main = STATE_ZONE[state.toUpperCase()] ?? EASTERN;
  if (lat == null || lng == null) return main;
  const region = (SPLIT_REGIONS[state.toUpperCase()] ?? []).find(
    (box) =>
      (box.north == null || lat < box.north) &&
      (box.south == null || lat >= box.south) &&
      (box.west == null || lng >= box.west) &&
      (box.east == null || lng < box.east),
  );
  return region?.zone ?? main;
}
