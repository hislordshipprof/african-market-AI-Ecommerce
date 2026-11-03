import { describe, expect, it } from "vitest";
import {
  applicationFeeForCapture,
  cardProcessingFeeCents,
  platformFeeCentsForCapture,
} from "./platform-fee";

describe("application fee", () => {
  it("recovers 2.9% + 30¢ on a $60 capture with a $3 courier fee", () => {
    expect(cardProcessingFeeCents(6000)).toBe(204);
    expect(platformFeeCentsForCapture(6000)).toBe(204);
    expect(applicationFeeForCapture(6000, 300)).toBe(504);
  });

  it("caps the fee at the captured amount", () => {
    expect(applicationFeeForCapture(50, 40)).toBe(50);
  });

  it("is zero when nothing was captured", () => {
    expect(applicationFeeForCapture(0, 300)).toBe(0);
  });
});
