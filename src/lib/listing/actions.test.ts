vi.mock("../storefront/cache", () => ({ revalidateStorefront: vi.fn() }));
import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidateStorefront } from "../storefront/cache";

const mockCreateListing = vi.fn();
const mockUpdateListing = vi.fn();
const mockDeactivateListing = vi.fn();
const mockReactivateListing = vi.fn();
const mockUpdateVariants = vi.fn();
const mockListMasterProducts = vi.fn();

vi.mock("./service", () => ({
  createListing: (...args: unknown[]) => mockCreateListing(...args),
  updateListing: (...args: unknown[]) => mockUpdateListing(...args),
  deactivateListing: (...args: unknown[]) => mockDeactivateListing(...args),
  reactivateListing: (...args: unknown[]) => mockReactivateListing(...args),
  updateVariants: (...args: unknown[]) => mockUpdateVariants(...args),
  listMasterProducts: (...args: unknown[]) => mockListMasterProducts(...args),
}));

vi.mock("../store-admin/session", () => ({
  requireStoreOwner: vi.fn().mockResolvedValue({
    user: { id: "owner-1", email: "owner@test.com" },
    store: { id: "store-1", slug: "test-store", name: "Test Store" },
    membership: { role: "owner" },
    session: {},
  }),
}));

import {
  createListingAction,
  updateListingAction,
  deactivateListingAction,
  reactivateListingAction,
  listMasterProductsAction,
} from "./actions";
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

  it.each([0, -5])("rejects variant weight %s", async (weightG) => {
    const result = await createListingAction(
      formData({
        ...VALID_LISTING,
        variants: JSON.stringify([{ label: "1kg", price: 800, weightG }]),
      }),
    );
    expect(result.error).toMatch(/weight/i);
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it("rejects empty variants", async () => {
    const result = await createListingAction(formData({ ...VALID_LISTING, variants: "[]" }));
    expect(result.error).toMatch(/variant/i);
  });

  it("calls createListing with correct args for counted mode", async () => {
    mockCreateListing.mockResolvedValueOnce({ id: "listing-1", variants: [] });
    const result = await createListingAction(formData(VALID_LISTING));
    expect(result).toEqual({ success: true, id: "listing-1" });
    expect(mockCreateListing).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store-1",
        customName: "Garri White",
        price: 800,
        stockMode: "counted",
        qty: 25,
        actor: { id: "owner-1", email: "owner@test.com" },
      }),
    );
  });

  it("calls createListing with status mode", async () => {
    mockCreateListing.mockResolvedValueOnce({ id: "listing-2", variants: [] });
    const result = await createListingAction(
      formData({ ...VALID_LISTING, stockMode: "status", status: "in_stock" }),
    );
    expect(result).toEqual({ success: true, id: "listing-2" });
    expect(mockCreateListing).toHaveBeenCalledWith(
      expect.objectContaining({
        stockMode: "status",
        status: "in_stock",
        qty: null,
      }),
    );
  });

  it("returns error on service failure", async () => {
    mockCreateListing.mockRejectedValueOnce(new Error("DB down"));
    const result = await createListingAction(formData(VALID_LISTING));
    expect(result.error).toBe("DB down");
  });
});

describe("updateListingAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects missing listingId", async () => {
    const result = await updateListingAction(formData({ price: "600" }));
    expect(result.error).toMatch(/listing id/i);
  });

  it("updates price and variants atomically", async () => {
    mockUpdateListing.mockResolvedValueOnce({ id: "listing-1" });
    const newVariants = JSON.stringify([
      { label: "500g", price: 400, weightG: 500 },
      { label: "2kg", price: 1500, weightG: 2000 },
    ]);
    const result = await updateListingAction(
      formData({ listingId: "listing-1", price: "600", variants: newVariants }),
    );
    expect(result).toEqual({ success: true, id: "listing-1" });
    expect(mockUpdateListing).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: "listing-1",
        price: 600,
        variants: expect.arrayContaining([
          expect.objectContaining({ label: "500g" }),
          expect.objectContaining({ label: "2kg" }),
        ]),
      }),
    );
    expect(mockUpdateVariants).not.toHaveBeenCalled();
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

  it("passes masterProductId through on update", async () => {
    mockUpdateListing.mockResolvedValueOnce({ id: "listing-1" });
    await updateListingAction(formData({ listingId: "listing-1", masterProductId: "mp-1" }));
    expect(mockUpdateListing).toHaveBeenCalledWith(
      expect.objectContaining({ masterProductId: "mp-1" }),
    );
  });

  it("stores a blank custom name as null when a master product is kept", async () => {
    mockUpdateListing.mockResolvedValueOnce({ id: "listing-1" });
    await updateListingAction(
      formData({ listingId: "listing-1", customName: "  ", masterProductId: "mp-1" }),
    );
    expect(mockUpdateListing).toHaveBeenCalledWith(
      expect.objectContaining({ customName: null, masterProductId: "mp-1" }),
    );
  });

  it("clears maxPerOrder when sent as empty string", async () => {
    mockUpdateListing.mockResolvedValueOnce({ id: "listing-1" });
    const result = await updateListingAction(
      formData({ listingId: "listing-1", maxPerOrder: "" }),
    );
    expect(result).toEqual({ success: true, id: "listing-1" });
    expect(mockUpdateListing).toHaveBeenCalledWith(
      expect.objectContaining({ maxPerOrder: null }),
    );
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

describe("deactivateListingAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls deactivateListing with session context", async () => {
    mockDeactivateListing.mockResolvedValueOnce({ id: "listing-1", active: false });
    const result = await deactivateListingAction("listing-1");
    expect(result).toEqual({ success: true });
    expect(mockDeactivateListing).toHaveBeenCalledWith(
      "store-1", "listing-1", { id: "owner-1", email: "owner@test.com" },
    );
  });

  it("returns error on failure", async () => {
    mockDeactivateListing.mockRejectedValueOnce(new Error("RLS violation"));
    const result = await deactivateListingAction("listing-1");
    expect(result.error).toBe("RLS violation");
  });
});

describe("reactivateListingAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls reactivateListing with session context", async () => {
    mockReactivateListing.mockResolvedValueOnce({ id: "listing-1", active: true });
    const result = await reactivateListingAction("listing-1");
    expect(result).toEqual({ success: true });
    expect(mockReactivateListing).toHaveBeenCalledWith(
      "store-1", "listing-1", { id: "owner-1", email: "owner@test.com" },
    );
  });
});

describe("listMasterProductsAction", () => {
  it("returns only id and name for each master product", async () => {
    mockListMasterProducts.mockResolvedValueOnce([
      { id: "mp-1", name: "Garri", description: "internal", weightG: 1000 },
    ]);
    const result = await listMasterProductsAction();
    expect(result).toEqual([{ id: "mp-1", name: "Garri" }]);
  });

  it("passes the query through with take 50", async () => {
    mockListMasterProducts.mockResolvedValueOnce([]);
    await listMasterProductsAction("egu");
    expect(mockListMasterProducts).toHaveBeenLastCalledWith("egu", 50);
  });
});

const INT4_MAX = 2147483647;

describe("parseVariantsJson", () => {
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

  it("validates optional IDs and both numeric boundaries without forwarding unknown fields", () => {
    const parsed = parseVariantsJson(JSON.stringify([
      {
        id: "var_edge",
        label: "1kg",
        price: INT4_MAX,
        weightG: INT4_MAX,
        sku: "SKU-1",
        barcode: "123",
        listingId: "other-listing",
        storeId: "other-store",
      },
      { label: "2kg", price: 0, weightG: 1 },
    ]));
    expect(parsed).toEqual([
      { id: "var_edge", label: "1kg", price: INT4_MAX, weightG: INT4_MAX, sku: "SKU-1", barcode: "123" },
      { label: "2kg", price: 0, weightG: 1, sku: null, barcode: null },
    ]);
    expect(parsed[0]).not.toHaveProperty("listingId");
    expect(parsed[0]).not.toHaveProperty("storeId");

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
