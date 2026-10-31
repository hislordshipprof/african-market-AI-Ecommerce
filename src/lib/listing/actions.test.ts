import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateListing = vi.fn();
const mockUpdateListing = vi.fn();
const mockDeactivateListing = vi.fn();
const mockReactivateListing = vi.fn();
const mockUpdateVariants = vi.fn();

vi.mock("./service", () => ({
  createListing: (...args: unknown[]) => mockCreateListing(...args),
  updateListing: (...args: unknown[]) => mockUpdateListing(...args),
  deactivateListing: (...args: unknown[]) => mockDeactivateListing(...args),
  reactivateListing: (...args: unknown[]) => mockReactivateListing(...args),
  updateVariants: (...args: unknown[]) => mockUpdateVariants(...args),
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
} from "./actions";

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

  it("rejects when no name or master product", async () => {
    const result = await createListingAction(formData({ ...VALID_LISTING, customName: "" }));
    expect(result.error).toMatch(/name.*required/i);
  });

  it("rejects invalid price", async () => {
    const result = await createListingAction(formData({ ...VALID_LISTING, price: "abc" }));
    expect(result.error).toMatch(/price/i);
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
        actorId: "owner-1",
        actorEmail: "owner@test.com",
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

  it("updates price and variants", async () => {
    mockUpdateListing.mockResolvedValueOnce({ id: "listing-1" });
    mockUpdateVariants.mockResolvedValueOnce([]);
    const newVariants = JSON.stringify([
      { label: "500g", price: 400, weightG: 500 },
      { label: "2kg", price: 1500, weightG: 2000 },
    ]);
    const result = await updateListingAction(
      formData({ listingId: "listing-1", price: "600", variants: newVariants }),
    );
    expect(result).toEqual({ success: true, id: "listing-1" });
    expect(mockUpdateListing).toHaveBeenCalledWith(
      expect.objectContaining({ listingId: "listing-1", price: 600 }),
    );
    expect(mockUpdateVariants).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store-1",
        listingId: "listing-1",
        variants: expect.arrayContaining([expect.objectContaining({ label: "500g" })]),
      }),
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

  it("returns error on service failure", async () => {
    mockUpdateListing.mockRejectedValueOnce(new Error("Not found"));
    const result = await updateListingAction(formData({ listingId: "x" }));
    expect(result.error).toBe("Not found");
  });
});

describe("deactivateListingAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls deactivateListing with session context", async () => {
    mockDeactivateListing.mockResolvedValueOnce({ id: "listing-1", active: false });
    const result = await deactivateListingAction("listing-1");
    expect(result).toEqual({ success: true });
    expect(mockDeactivateListing).toHaveBeenCalledWith(
      "store-1", "listing-1", "owner-1", "owner@test.com",
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
      "store-1", "listing-1", "owner-1", "owner@test.com",
    );
  });
});
