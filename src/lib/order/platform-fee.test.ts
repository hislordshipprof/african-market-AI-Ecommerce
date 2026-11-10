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
    expect(applicationFeeForCapture(6000, { fulfillment: "courier", deliveryFeeCents: 300 })).toBe(504);
  });

  it("rounds 2.9% of 1234 cents to 36 and adds 30 for 66 cents", () => {
    expect(platformFeeCentsForCapture(1234)).toBe(66);
  });

  it("charges 31 cents on a 50 cent total", () => {
    expect(platformFeeCentsForCapture(50)).toBe(31);
  });

  it("caps a fee that would exceed the total", () => {
    expect(platformFeeCentsForCapture(20)).toBe(20);
  });

  it("caps the fee at the captured amount", () => {
    expect(applicationFeeForCapture(50, { fulfillment: "courier", deliveryFeeCents: 40 })).toBe(50);
  });

  it("is zero when nothing was captured", () => {
    expect(applicationFeeForCapture(0, { fulfillment: "courier", deliveryFeeCents: 300 })).toBe(0);
  });
});
