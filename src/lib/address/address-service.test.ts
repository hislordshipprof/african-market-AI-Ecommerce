import { afterEach, describe, expect, it, vi } from "vitest";
import { assessRadius } from "./geo";
import { getAddressProvider, setAddressProvider } from "./provider";
import { locateWithCensus, suggestFromPhoton } from "./remote";

const STORE = { lat: 38.84505589808, lng: -76.92836638093, radiusMi: 7 };

function censusBody(
  matches: Array<{ x: number; y: number; matched: string; city: string; state: string; zip: string }>,
) {
  return {
    result: {
      addressMatches: matches.map((match) => ({
        matchedAddress: match.matched,
        coordinates: { x: match.x, y: match.y },
        addressComponents: { city: match.city, state: match.state, zip: match.zip },
      })),
    },
  };
}

const WHITE_HOUSE = {
  x: -77.035189204737,
  y: 38.898702605245,
  matched: "1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500",
  city: "WASHINGTON",
  state: "DC",
  zip: "20500",
};

const FENTON = {
  x: -77.024773544996,
  y: 38.996293163535,
  matched: "8505 FENTON ST, SILVER SPRING, MD, 20910",
  city: "SILVER SPRING",
  state: "MD",
  zip: "20910",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("address service", () => {
  it("confirm uses Census x as longitude and y as latitude and applies the radius", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = new URL(String(input));
      const address = url.searchParams.get("address") ?? "";
      if (!address || address.length > 100) {
        return jsonResponse({ errors: ["Address cannot be empty and cannot exceed 100 characters"], status: "400" }, 400);
      }
      if (address.startsWith("1600")) return jsonResponse(censusBody([WHITE_HOUSE]));
      if (address.startsWith("8505")) return jsonResponse(censusBody([FENTON]));
      if (address.startsWith("200")) {
        return jsonResponse(censusBody([
          WHITE_HOUSE,
          { ...FENTON, matched: "200 OTHER ST, WASHINGTON, DC, 20001" },
        ]));
      }
      return jsonResponse(censusBody([]));
    });

    const near = await locateWithCensus(
      { line1: "1600 Pennsylvania Ave NW", city: "Washington", state: "DC", zip: "" },
      fetchImpl,
    );
    expect(near.ok).toBe(true);
    if (!near.ok) return;
    expect(near.match.lng).toBe(WHITE_HOUSE.x);
    expect(near.match.lat).toBe(WHITE_HOUSE.y);
    expect(near.match.state).toBe("DC");
    const nearRadius = assessRadius(near.match, STORE);
    expect(nearRadius.roundedMi).toBe(6.8);
    expect(nearRadius.withinRadius).toBe(true);
    const swapped = assessRadius({ lat: near.match.lng, lng: near.match.lat }, STORE);
    expect(swapped.withinRadius).toBe(false);

    const far = await locateWithCensus(
      { line1: "8505 Fenton St", city: "Silver Spring", state: "MD", zip: "20910" },
      fetchImpl,
    );
    expect(far.ok).toBe(true);
    if (!far.ok) return;
    expect(assessRadius(far.match, STORE).roundedMi).toBe(11.7);
    expect(assessRadius(far.match, STORE).withinRadius).toBe(false);

    const none = await locateWithCensus(
      { line1: "1 Missing St", city: "Washington", state: "DC", zip: "20001" },
      fetchImpl,
    );
    expect(none).toEqual({ ok: false, code: "no-match" });

    const ambiguous = await locateWithCensus(
      { line1: "200 Ambiguous", city: "Washington", state: "DC", zip: "20001" },
      fetchImpl,
    );
    expect(ambiguous).toEqual({ ok: false, code: "ambiguous" });

    const empty = await locateWithCensus(
      { line1: "", city: "", state: "", zip: "" },
      fetchImpl,
    );
    expect(empty).toEqual({ ok: false, code: "rejected" });
    const tooLong = "a".repeat(101);
    const long = await locateWithCensus(
      { line1: tooLong, city: "Washington", state: "DC", zip: "20001" },
      fetchImpl,
    );
    expect(long).toEqual({ ok: false, code: "rejected" });

    const called = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(called.some((url) => url.includes("1600"))).toBe(true);
    expect(called.every((url) => url.includes("format=json") && url.includes("benchmark=Public_AR_Current"))).toBe(true);
    expect(called.some((url) => url.includes(tooLong))).toBe(false);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("user-agent")).toMatch(/^AfricanMarkets\/1\.0 \(\+/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(5_000);
  });

  it("suggestions are empty when Photon fails or times out", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const failing = vi.fn(async () => {
      throw new Error("photon down");
    });
    await expect(suggestFromPhoton("8505 Fen", STORE, failing)).resolves.toEqual([]);

    const timingOut = vi.fn(async () => {
      const error = new Error("timeout");
      error.name = "TimeoutError";
      throw error;
    });
    await expect(suggestFromPhoton("8505 Fen", STORE, timingOut)).resolves.toEqual([]);

    const ok = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = new URL(String(input));
      expect(url.searchParams.get("layer")).toBe("house");
      expect(url.searchParams.get("bbox")).toBeTruthy();
      expect(url.searchParams.get("countrycode")).toBe("US");
      return jsonResponse({
        features: [
          { properties: { name: "Fenton St bus stop", countrycode: "US" }, geometry: { coordinates: [-77, 39] } },
          {
            properties: { housenumber: "8505", street: "Fenton Street", city: "Silver Spring", state: "MD", postcode: "20910", countrycode: "US" },
            geometry: { coordinates: [-77.02, 38.99] },
          },
          {
            properties: { housenumber: "8505", street: "Fenton Street", city: "Silver Spring", state: "MD", postcode: "20910", countrycode: "US" },
            geometry: { coordinates: [-77.02, 38.99] },
          },
          {
            properties: { housenumber: "10", street: "Rural Road", state: "MD", countrycode: "US" },
            geometry: { coordinates: [-77.1, 39.1] },
          },
        ],
      });
    });
    const suggestions = await suggestFromPhoton("8505 Fen", STORE, ok);
    expect(suggestions).toEqual([
      {
        line1: "8505 Fenton Street",
        city: "Silver Spring",
        state: "MD",
        zip: "20910",
        label: "8505 Fenton Street, Silver Spring, MD, 20910",
      },
      {
        line1: "10 Rural Road",
        city: "",
        state: "MD",
        zip: "",
        label: "10 Rural Road, MD",
      },
    ]);
    const photonInit = ok.mock.calls[0][1] as RequestInit;
    expect(new Headers(photonInit.headers).get("user-agent")).toMatch(/^AfricanMarkets\/1\.0 \(\+/);
    expect(timeout).toHaveBeenCalledWith(1_500);
  });

  it.each([
    ["on Vercel", { VERCEL: "1", NODE_ENV: "production", CI: "true", E2E_FAKE_ADDRESS: "1" }],
    ["in production without CI", { VERCEL: "", NODE_ENV: "production", CI: "", E2E_FAKE_ADDRESS: "1" }],
  ])("the fake address service is refused %s", async (_where, env) => {
    setAddressProvider(null);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return jsonResponse(censusBody([WHITE_HOUSE]));
    });
    vi.stubGlobal("fetch", fetchImpl);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const located = await getAddressProvider(env as NodeJS.ProcessEnv).locate({
      line1: "1600 Pennsylvania Ave NW",
      city: "Washington",
      state: "DC",
      zip: "20500",
    });
    expect(located.ok).toBe(true);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("https://geocoding.geo.census.gov/");
  });
});
