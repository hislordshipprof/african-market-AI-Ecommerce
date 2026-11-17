import { describe, expect, it } from "vitest";
import { encodeOrderCursor, parseOrderSearch } from "./order-search";

const blank = { storeId: "", number: "", email: "", phone: "", status: "", fulfillment: "", from: "", to: "", cursor: "" };

describe("parseOrderSearch", () => {
  it("normalises the email to the lowercase form checkout stores and keeps the phone exact", () => {
    const parsed = parseOrderSearch({ ...blank, email: "  Ngozi@Example.COM ", phone: " +1 (555) 010-2030 " });
    expect(parsed).toMatchObject({ ok: true, filters: { email: "ngozi@example.com", phone: "+1 (555) 010-2030" } });
  });

  it("refuses an order number without a store, since numbers repeat across stores", () => {
    const parsed = parseOrderSearch({ ...blank, number: "1042" });
    expect(parsed).toEqual({ ok: false, error: "Choose a store to search by order number." });
  });

  it("accepts a store plus order number", () => {
    const parsed = parseOrderSearch({ ...blank, storeId: "store_1", number: "1042" });
    expect(parsed).toMatchObject({ ok: true, filters: { storeId: "store_1", number: 1042 } });
  });

  it("rejects a status or fulfillment outside the known lists", () => {
    expect(parseOrderSearch({ ...blank, status: "LOST" }).ok).toBe(false);
    expect(parseOrderSearch({ ...blank, status: "%" }).ok).toBe(false);
    expect(parseOrderSearch({ ...blank, fulfillment: "drone" }).ok).toBe(false);
    expect(parseOrderSearch({ ...blank, status: "REFUND_FAILED", fulfillment: "courier" })).toMatchObject({
      ok: true,
      filters: { status: "REFUND_FAILED", fulfillment: "courier" },
    });
  });

  it("rejects impossible dates and a range that ends before it starts", () => {
    expect(parseOrderSearch({ ...blank, from: "2026-02-30" }).ok).toBe(false);
    expect(parseOrderSearch({ ...blank, from: "2026-03-10", to: "2026-03-09" })).toEqual({
      ok: false,
      error: "The end date is before the start date.",
    });
    expect(parseOrderSearch({ ...blank, from: "2026-03-09", to: "2026-03-10" })).toMatchObject({
      ok: true,
      filters: { from: "2026-03-09", to: "2026-03-10" },
    });
  });

  it("round-trips a page cursor and refuses a forged one", () => {
    const cursor = encodeOrderCursor({ createdAt: new Date("2026-03-10T15:04:05.123Z"), id: "cmabc123" });
    expect(parseOrderSearch({ ...blank, cursor })).toMatchObject({
      ok: true,
      filters: { cursor: { createdAt: new Date("2026-03-10T15:04:05.123Z"), id: "cmabc123" } },
    });
    expect(parseOrderSearch({ ...blank, cursor: "not-a-cursor" }).ok).toBe(false);
    const forged = Buffer.from("2026-03-10T15:04:05.123Z|x' OR 1=1").toString("base64url");
    expect(parseOrderSearch({ ...blank, cursor: forged }).ok).toBe(false);
  });

  it("treats a missing field the same as an empty one", () => {
    expect(parseOrderSearch({})).toMatchObject({
      ok: true,
      filters: { storeId: null, number: null, email: null, phone: null, status: null, fulfillment: null, from: null, to: null, cursor: null },
    });
  });
});
