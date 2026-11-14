vi.mock("../storefront/cache", () => ({ revalidateStorefront: vi.fn() }));
import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidateStorefront } from "../storefront/cache";

const mockCreateListing = vi.fn();
const mockUpdateListing = vi.fn();

vi.mock("./service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service")>();
  return {
    ...actual,
    createListing: (...args: unknown[]) => mockCreateListing(...args),
    updateListing: (...args: unknown[]) => mockUpdateListing(...args),
    deactivateListing: vi.fn(),
    reactivateListing: vi.fn(),
    updateVariants: vi.fn(),
    listMasterProducts: vi.fn(),
  };
});

vi.mock("../store-admin/session", () => ({
  requireStoreOwner: vi.fn().mockResolvedValue({
    user: { id: "owner-1", email: "owner@test.com" },
    store: { id: "store-1", slug: "test-store", name: "Test Store" },
    membership: { role: "owner" },
    session: {},
  }),
}));

import { createListingAction, updateListingAction } from "./actions";
import { parseVariantsJson } from "./parse-variants";

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    fd.set(k, v);
  }
  return fd;
}

const VALID_LISTING = {
  customName: "Garri White",
  price: "800",
  stockMode: "counted",
  qty: "25",
  frozen: "false",
  perishable: "false",
  variants: JSON.stringify([{ label: "1kg", price: 800, weightG: 1000 }]),
};

describe("createListingAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("expires storefront reads after a committed listing mutation", async () => {
    mockCreateListing.mockResolvedValueOnce({ id: "created" });
    expect(await createListingAction(formData(VALID_LISTING))).toEqual({ success: true, id: "created" });
    expect(revalidateStorefront).toHaveBeenCalledWith("store-1");
  });

  it("does not invalidate a failed listing mutation", async () => {
    mockCreateListing.mockRejectedValueOnce(new Error("Not saved"));
    expect(await createListingAction(formData(VALID_LISTING))).toEqual({ error: "Not saved" });
    expect(revalidateStorefront).not.toHaveBeenCalled();
  });

  it("rejects when no name or master product", async () => {
    const result = await createListingAction(formData({ ...VALID_LISTING, customName: "" }));
    expect(result.error).toMatch(/name.*required/i);
  });

  it("rejects an object or null in place of the listing form and does not write", async () => {
    await expect(createListingAction({} as never)).resolves.toEqual({
      error: "Product name or master product is required",
    });
    await expect(createListingAction(null as never)).resolves.toEqual({
      error: "Product name or master product is required",
    });
    await expect(updateListingAction({} as never)).resolves.toEqual({
      error: "Listing ID is required",
    });
    expect(mockCreateListing).not.toHaveBeenCalled();
    expect(mockUpdateListing).not.toHaveBeenCalled();
  });

  it("rejects invalid price", async () => {
    const result = await createListingAction(formData({ ...VALID_LISTING, price: "abc" }));
    expect(result.error).toMatch(/price/i);
  });

  it("rejects negative price", async () => {
    const result = await createListingAction(formData({ ...VALID_LISTING, price: "-500" }));
    expect(result.error).toMatch(/price/i);
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it("rejects negative qty", async () => {
    const result = await createListingAction(
      formData({ ...VALID_LISTING, qty: "-10" }),
    );
    expect(result.error).toMatch(/qty|quantity/i);
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it("rejects invalid stockMode", async () => {
    const result = await createListingAction(
      formData({ ...VALID_LISTING, stockMode: "foobar" }),
    );
    expect(result.error).toMatch(/stock mode/i);
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it("rejects negative variant price", async () => {
    const result = await createListingAction(
      formData({
        ...VALID_LISTING,
        variants: JSON.stringify([{ label: "1kg", price: -100, weightG: 1000 }]),
      }),
    );
    expect(result.error).toMatch(/variant.*price/i);
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it("rejects variant weight 0", async () => {
    const result = await createListingAction(
      formData({
        ...VALID_LISTING,
        variants: JSON.stringify([{ label: "1kg", price: 800, weightG: 0 }]),
      }),
    );
    expect(result.error).toMatch(/weight/i);
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it("rejects empty variants", async () => {
    const result = await createListingAction(formData({ ...VALID_LISTING, variants: "[]" }));
    expect(result.error).toMatch(/variant/i);
  });

});

describe("updateListingAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects missing listingId", async () => {
    const result = await updateListingAction(formData({ price: "600" }));
    expect(result.error).toMatch(/listing id/i);
  });

  it("rejects update when all variants resolve to empty, without calling the service", async () => {
    const result = await updateListingAction(
      formData({ listingId: "listing-1", price: "600", variants: "[]" }),
    );
    expect(result.error).toMatch(/variant/i);
    expect(mockUpdateListing).not.toHaveBeenCalled();
  });

  it("rejects update with variant weight 0", async () => {
    const result = await updateListingAction(
      formData({
        listingId: "listing-1",
        variants: JSON.stringify([{ label: "1kg", price: 800, weightG: 0 }]),
      }),
    );
    expect(result.error).toMatch(/weight/i);
    expect(mockUpdateListing).not.toHaveBeenCalled();
  });

  it("rejects blanking customName when no masterProductId", async () => {
    const result = await updateListingAction(
      formData({ listingId: "listing-1", customName: "" }),
    );
    expect(result.error).toMatch(/name/i);
    expect(mockUpdateListing).not.toHaveBeenCalled();
  });

  it("rejects invalid stockMode on update", async () => {
    const result = await updateListingAction(
      formData({ listingId: "listing-1", stockMode: "invalid" }),
    );
    expect(result.error).toMatch(/stock mode/i);
    expect(mockUpdateListing).not.toHaveBeenCalled();
  });

  it("rejects negative price on update", async () => {
    const result = await updateListingAction(
      formData({ listingId: "listing-1", price: "-100" }),
    );
    expect(result.error).toMatch(/price/i);
    expect(mockUpdateListing).not.toHaveBeenCalled();
  });

  it("returns error on service failure", async () => {
    mockUpdateListing.mockRejectedValueOnce(new Error("Not found"));
    const result = await updateListingAction(formData({ listingId: "x" }));
    expect(result.error).toBe("Not found");
    expect(revalidateStorefront).not.toHaveBeenCalled();
  });
});

const INT4_MAX = 2147483647;

describe("parseVariantsJson", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parseVariantsJson passes string ids, rejects bad ids and non-whole or out-of-range amounts", () => {
    expect(parseVariantsJson(JSON.stringify([
      { id: "var_1", label: "1kg", price: 800, weightG: 1000 },
    ]))).toEqual([
      { id: "var_1", label: "1kg", price: 800, weightG: 1000, sku: null, barcode: null },
    ]);

    for (const id of [5, {}, "", null, false, ["var_1"]]) {
      expect(() => parseVariantsJson(JSON.stringify([
        { label: "1kg", price: 800, weightG: 1000 },
        { id, label: "2kg", price: 900, weightG: 2000 },
      ]))).toThrow("Variant 2: invalid id");
    }

    expect(() => parseVariantsJson(JSON.stringify([
      { label: "1kg", price: true, weightG: 1000 },
    ]))).toThrow("Variant 1: valid non-negative price is required");
    expect(() => parseVariantsJson(JSON.stringify([
      { label: "1kg", price: 12.5, weightG: 1000 },
    ]))).toThrow("Variant 1: price must be a whole number of cents");
    expect(() => parseVariantsJson(JSON.stringify([
      { label: "1kg", price: INT4_MAX + 1, weightG: 1000 },
    ]))).toThrow("Variant 1: price must be a whole number of cents");
    expect(() => parseVariantsJson(JSON.stringify([
      { label: "1kg", price: 800, weightG: 1.5 },
    ]))).toThrow("Variant 1: weight must be a whole number of grams");
    expect(() => parseVariantsJson(JSON.stringify([
      { label: "1kg", price: 800, weightG: INT4_MAX + 1 },
    ]))).toThrow("Variant 1: weight must be a whole number of grams");
  });

  it("validates optional IDs and both numeric boundaries and rejects unknown fields", () => {
    const parsed = parseVariantsJson(JSON.stringify([
      {
        id: "var_edge",
        label: "1kg",
        price: INT4_MAX,
        weightG: INT4_MAX,
        sku: "SKU-1",
        barcode: "123",
      },
      { label: "2kg", price: 0, weightG: 1 },
    ]));
    expect(parsed).toEqual([
      { id: "var_edge", label: "1kg", price: INT4_MAX, weightG: INT4_MAX, sku: "SKU-1", barcode: "123" },
      { label: "2kg", price: 0, weightG: 1, sku: null, barcode: null },
    ]);
    expect(() => parseVariantsJson(JSON.stringify([
      { label: "1kg", price: 800, weightG: 1000, listingId: "other-listing", storeId: "other-store" },
    ]))).toThrow("Variant 1: unknown field");

    expect(() => parseVariantsJson(JSON.stringify([
      { label: "1kg", price: -1, weightG: 1000 },
    ]))).toThrow("Variant 1: valid non-negative price is required");
    expect(() => parseVariantsJson(JSON.stringify([
      { label: "1kg", price: 800, weightG: 0 },
    ]))).toThrow("Variant 1: weight must be greater than 0");
  });

  it("does not call the listing service when an id or amount is invalid", async () => {
    const bad = await updateListingAction(formData({
      listingId: "listing-1",
      variants: JSON.stringify([{ id: 5, label: "1kg", price: 800, weightG: 1000 }]),
    }));
    expect(bad.error).toBe("Variant 1: invalid id");
    expect(mockUpdateListing).not.toHaveBeenCalled();

    const fractional = await updateListingAction(formData({
      listingId: "listing-1",
      variants: JSON.stringify([{ label: "1kg", price: 12.5, weightG: 1000 }]),
    }));
    expect(fractional.error).toBe("Variant 1: price must be a whole number of cents");
    expect(mockUpdateListing).not.toHaveBeenCalled();
  });
});
