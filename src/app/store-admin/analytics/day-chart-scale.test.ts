import { describe, expect, it } from "vitest";
import { dayChartScale } from "./day-chart-scale";

const day = (netCents: number) => ({ netCents });

describe("day chart scale", () => {
  it("a range with no sales has no peak to label", () => {
    expect(dayChartScale([day(0), day(0), day(0)])).toEqual({ max: 1, peakCents: null });
  });

  it("refund-only days have no peak either", () => {
    expect(dayChartScale([day(0), day(-1250)]).peakCents).toBeNull();
  });

  it("the peak is the best day's net", () => {
    expect(dayChartScale([day(500), day(4200), day(-300)])).toEqual({ max: 4200, peakCents: 4200 });
  });
});
