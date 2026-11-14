import { describe, expect, it } from "vitest";
import { loadedVariantRow, serializeVariants } from "./variant-form";

describe("loadedVariantRow", () => {
  it("keeps the variant id on the row the form will save", () => {
    expect(loadedVariantRow({
      id: "var_loaded",
      label: "1kg",
      price: 800,
      weightG: 1000,
      weightPlaceholder: false,
      sku: "SKU-1",
      barcode: null,
    })).toEqual({
      key: "var_loaded",
      id: "var_loaded",
      label: "1kg",
      price: "8.00",
      weightG: "1000",
      weightPlaceholder: false,
      sku: "SKU-1",
      barcode: null,
    });
  });

  it("a placeholder weight starts empty so saving cannot clear the flag by accident", () => {
    expect(loadedVariantRow({
      id: "var_ph",
      label: "Default",
      price: 100,
      weightG: 100,
      weightPlaceholder: true,
      sku: null,
      barcode: null,
    }).weightG).toBe("");
  });
});

describe("serializeVariants", () => {
  it("loaded rows carry their id, new rows carry none, and only new blank-label rows are dropped", () => {
    const json = serializeVariants([
      { id: "var_loaded", key: "var_loaded", label: " 1kg ", price: "8.00", weightG: "1000", sku: "SKU-1", barcode: "123" },
      { key: "react-key-not-an-id", label: "2kg", price: "12.345", weightG: "2000" },
      { key: "new-blank", label: "   ", price: "1.00", weightG: "100" },
      // #392 item 3: a cleared label and a blank price reach the server, which refuses them.
      { id: "var_cleared", key: "var_cleared", label: "   ", price: "", weightG: "100" },
    ]);
    expect(JSON.parse(json)).toEqual([
      { id: "var_loaded", label: "1kg", price: 800, weightG: 1000, sku: "SKU-1", barcode: "123" },
      { label: "2kg", price: 1235, weightG: 2000, sku: null, barcode: null },
      { id: "var_cleared", label: "", price: null, weightG: 100, sku: null, barcode: null },
    ]);
  });

  it("serialization preserves loaded IDs and carried fields but never promotes new React keys", () => {
    const json = serializeVariants([
      { key: "crypto-random-uuid", label: "500g", price: "4.00", weightG: "500", sku: null, barcode: null, weightPlaceholder: true },
    ]);
    const row = JSON.parse(json)[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty("id");
    expect(row).not.toHaveProperty("key");
    expect(row).not.toHaveProperty("weightPlaceholder");
    expect(row).toEqual({ label: "500g", price: 400, weightG: 500, sku: null, barcode: null });
  });
});
