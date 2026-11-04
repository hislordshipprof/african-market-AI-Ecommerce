import { describe, expect, it } from "vitest";
import { serializeVariants } from "./variant-form";

describe("serializeVariants", () => {
  it("loaded rows carry their id, new rows carry none, and blank-label rows are dropped", () => {
    const json = serializeVariants([
      { id: "var_loaded", key: "var_loaded", label: " 1kg ", price: "8.00", weightG: "1000", sku: "SKU-1", barcode: "123" },
      { key: "react-key-not-an-id", label: "2kg", price: "12.345", weightG: "2000" },
      { id: "var_blank", key: "var_blank", label: "   ", price: "1.00", weightG: "100" },
    ]);
    expect(JSON.parse(json)).toEqual([
      { id: "var_loaded", label: "1kg", price: 800, weightG: 1000, sku: "SKU-1", barcode: "123" },
      { label: "2kg", price: 1235, weightG: 2000, sku: null, barcode: null },
    ]);
  });

  it("serialization preserves loaded IDs and carried fields but never promotes new React keys", () => {
    const json = serializeVariants([
      { key: "crypto-random-uuid", label: "500g", price: "4.00", weightG: "500", sku: null, barcode: null },
    ]);
    const row = JSON.parse(json)[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty("id");
    expect(row).not.toHaveProperty("key");
    expect(row).toEqual({ label: "500g", price: 400, weightG: 500, sku: null, barcode: null });
  });
});
