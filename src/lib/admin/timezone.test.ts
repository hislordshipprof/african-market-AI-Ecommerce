import { describe, expect, it } from "vitest";
import { USPS_STATE_CODES } from "../customer-account/address-validation";
import { timezoneForAddress, VALID_US_TIMEZONES } from "./timezone";

describe("timezoneForAddress (#780)", () => {
  it.each([
    ["Houston", "TX", 29.7604, -95.3698, "America/Chicago"],
    ["El Paso", "TX", 31.7619, -106.485, "America/Denver"],
    ["New York", "NY", 40.7128, -74.006, "America/New_York"],
    ["Pensacola", "FL", 30.4213, -87.2169, "America/Chicago"],
    ["Tallahassee", "FL", 30.4383, -84.2807, "America/New_York"],
    ["Nashville", "TN", 36.1627, -86.7816, "America/Chicago"],
    ["Chattanooga", "TN", 35.0456, -85.3097, "America/New_York"],
    ["Knoxville", "TN", 35.9606, -83.9207, "America/New_York"],
    ["Louisville", "KY", 38.2527, -85.7585, "America/New_York"],
    ["Bowling Green", "KY", 36.9685, -86.4808, "America/Chicago"],
    ["Indianapolis", "IN", 39.7684, -86.1581, "America/New_York"],
    ["Gary", "IN", 41.5934, -87.3464, "America/Chicago"],
    ["Evansville", "IN", 37.9716, -87.5711, "America/Chicago"],
    ["Terre Haute", "IN", 39.4667, -87.4139, "America/New_York"],
    ["Detroit", "MI", 42.3314, -83.0458, "America/New_York"],
    ["Iron Mountain", "MI", 45.8202, -88.066, "America/Chicago"],
    ["Marquette", "MI", 46.5436, -87.3954, "America/New_York"],
    ["Fargo", "ND", 46.8772, -96.7898, "America/Chicago"],
    ["Dickinson", "ND", 46.8792, -102.7896, "America/Denver"],
    ["Sioux Falls", "SD", 43.5446, -96.7311, "America/Chicago"],
    ["Rapid City", "SD", 44.0805, -103.231, "America/Denver"],
    ["Omaha", "NE", 41.2565, -95.9345, "America/Chicago"],
    ["Scottsbluff", "NE", 41.8666, -103.6672, "America/Denver"],
    ["Wichita", "KS", 37.6872, -97.3301, "America/Chicago"],
    ["Goodland", "KS", 39.3508, -101.7101, "America/Denver"],
    ["Boise", "ID", 43.615, -116.2023, "America/Denver"],
    ["Coeur d'Alene", "ID", 47.6777, -116.7805, "America/Los_Angeles"],
    ["Portland", "OR", 45.5152, -122.6784, "America/Los_Angeles"],
    ["Ontario", "OR", 44.0266, -116.9629, "America/Denver"],
    ["Phoenix", "AZ", 33.4484, -112.074, "America/Phoenix"],
    ["Anchorage", "AK", 61.2181, -149.9003, "America/Anchorage"],
    ["Honolulu", "HI", 21.3069, -157.8583, "Pacific/Honolulu"],
    ["Washington", "DC", 38.9072, -77.0369, "America/New_York"],
  ])("%s, %s is %s", (_city, state, lat, lng, zone) => {
    expect(timezoneForAddress(state, lat, lng)).toBe(zone);
  });

  it("without coordinates uses the state's main zone", () => {
    expect(timezoneForAddress("TX", null, null)).toBe("America/Chicago");
    expect(timezoneForAddress("CA", null, null)).toBe("America/Los_Angeles");
    expect(timezoneForAddress("ID", null, null)).toBe("America/Denver");
    expect(timezoneForAddress("IN", null, null)).toBe("America/New_York");
  });

  it("always returns a zone the store form accepts", () => {
    for (const state of USPS_STATE_CODES) {
      expect(VALID_US_TIMEZONES).toContain(timezoneForAddress(state, null, null));
    }
  });
});
