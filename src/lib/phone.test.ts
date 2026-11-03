import { describe, it, expect } from "vitest";
import { normalizePhone, isValidUsPhone } from "./phone";

describe("normalizePhone", () => {
  it("normalizes 10-digit US number", () => {
    expect(normalizePhone("2025551234")).toBe("+12025551234");
  });

  it("normalizes 11-digit US number with leading 1", () => {
    expect(normalizePhone("12025551234")).toBe("+12025551234");
  });

  it("strips formatting characters", () => {
    expect(normalizePhone("(202) 555-1234")).toBe("+12025551234");
    expect(normalizePhone("202.555.1234")).toBe("+12025551234");
    expect(normalizePhone("+1 202 555 1234")).toBe("+12025551234");
  });

  it("rejects too-short numbers", () => {
    expect(normalizePhone("555123")).toBeNull();
  });

  it("rejects too-long numbers", () => {
    expect(normalizePhone("120255512345")).toBeNull();
  });

  it("rejects NPA starting with 0", () => {
    expect(normalizePhone("0025551234")).toBeNull();
  });

  it("rejects NPA starting with 1", () => {
    expect(normalizePhone("1025551234")).toBeNull();
  });

  it("rejects NXX starting with 0", () => {
    expect(normalizePhone("2020551234")).toBeNull();
  });

  it("rejects NXX starting with 1", () => {
    expect(normalizePhone("2021551234")).toBeNull();
  });

  it("rejects 900 premium-rate NPA", () => {
    expect(normalizePhone("9005551234")).toBeNull();
  });

  it("rejects 976 premium-rate NXX", () => {
    expect(normalizePhone("2029761234")).toBeNull();
  });

  it("rejects N11 codes (911, 411, etc.)", () => {
    expect(normalizePhone("9115551234")).toBeNull();
    expect(normalizePhone("4115551234")).toBeNull();
    expect(normalizePhone("2115551234")).toBeNull();
    expect(normalizePhone("8115551234")).toBeNull();
  });

  it("accepts valid area codes", () => {
    expect(normalizePhone("2125551234")).toBe("+12125551234"); // NYC
    expect(normalizePhone("3105551234")).toBe("+13105551234"); // LA
    expect(normalizePhone("7135551234")).toBe("+17135551234"); // Houston
  });

  it("accepts US territory area codes", () => {
    expect(normalizePhone("7875551234")).toBe("+17875551234"); // Puerto Rico
    expect(normalizePhone("3405551234")).toBe("+13405551234"); // USVI
    expect(normalizePhone("6715551234")).toBe("+16715551234"); // Guam
  });

  it("rejects Canadian area codes", () => {
    expect(normalizePhone("4165551234")).toBeNull(); // Toronto
    expect(normalizePhone("6045551234")).toBeNull(); // Vancouver
    expect(normalizePhone("5145551234")).toBeNull(); // Montreal
    expect(normalizePhone("9055551234")).toBeNull(); // Ontario
  });

  it("rejects Caribbean non-US area codes", () => {
    expect(normalizePhone("2425551234")).toBeNull(); // Bahamas
    expect(normalizePhone("8765551234")).toBeNull(); // Jamaica
    expect(normalizePhone("8685551234")).toBeNull(); // Trinidad
  });

  it("rejects unassigned area code 999", () => {
    expect(normalizePhone("9995551234")).toBeNull();
  });
});

describe("isValidUsPhone", () => {
  it("returns true for valid US number", () => {
    expect(isValidUsPhone("(202) 555-1234")).toBe(true);
  });

  it("returns false for premium-rate number", () => {
    expect(isValidUsPhone("900-555-1234")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isValidUsPhone("")).toBe(false);
  });
});
