import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();

vi.mock("./db", () => ({
  platformAdmin: {
    store: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

vi.mock("next/cache", () => ({
  unstable_cache: vi.fn((fn: () => unknown) => fn),
  revalidateTag: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
}));

import { addDomainToStore, getDomainStatus, removeDomainFromStore } from "./domain-service";
import {
  FakeVercelDomainsAdapter,
  setVercelDomainsAdapter,
  resetVercelDomainsAdapter,
} from "./vercel-domains";

describe("domain-service", () => {
  let fakeAdapter: FakeVercelDomainsAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeAdapter = new FakeVercelDomainsAdapter();
    setVercelDomainsAdapter(fakeAdapter);
  });

  afterEach(() => {
    resetVercelDomainsAdapter();
  });

  const storeA = {
    id: "store-a",
    slug: "mama-ngozi",
    name: "Mama Ngozi",
    customDomain: null,
    logoUrl: null,
    brandColor: null,
    themePreset: "palm-and-shea",
    status: "active",
    hours: null,
    prepTimeMinutes: 30,
    deliveryRadiusMi: 8,
    minimumOrderCents: 3500,
    pickupEnabled: false,
    autoRefundLimitCents: 2500,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  describe("addDomainToStore", () => {
    it("adds domain, calls Vercel adapter, updates store", async () => {
      mockFindUnique
        .mockResolvedValueOnce(storeA) // find store by id
        .mockResolvedValueOnce(null); // check domain uniqueness
      mockUpdate.mockResolvedValueOnce({ ...storeA, customDomain: "shop.mamasmarket.com" });

      const result = await addDomainToStore("store-a", "shop.mamasmarket.com");

      expect(result).toEqual({
        ok: true,
        domain: "shop.mamasmarket.com",
        verified: false,
        cname: "cname.vercel-dns.com",
      });
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: "store-a" },
        data: { customDomain: "shop.mamasmarket.com" },
      });
    });

    it("refuses a second domain while the store still has one, without calling Vercel", async () => {
      const addSpy = vi.spyOn(fakeAdapter, "addDomain");
      mockFindUnique.mockResolvedValueOnce({ ...storeA, customDomain: "old.mamasmarket.com" });

      const result = await addDomainToStore("store-a", "new.mamasmarket.com");

      expect(result).toEqual({
        ok: false,
        error: "Store already has a custom domain; remove it first",
        status: 409,
      });
      expect(addSpy).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("returns 404 when store not found", async () => {
      mockFindUnique.mockResolvedValueOnce(null);

      const result = await addDomainToStore("nonexistent", "shop.test.com");
      expect(result).toEqual({
        ok: false,
        error: "Store not found",
        status: 404,
      });
    });

    it("returns 409 when domain is assigned to another store", async () => {
      mockFindUnique
        .mockResolvedValueOnce(storeA)
        .mockResolvedValueOnce({ id: "store-b", slug: "other-store" });

      const result = await addDomainToStore("store-a", "shop.mamasmarket.com");
      expect(result).toEqual({
        ok: false,
        error: "Domain is already assigned to another store",
        status: 409,
      });
    });

    it("returns 409 when Vercel says domain is in use", async () => {
      mockFindUnique
        .mockResolvedValueOnce(storeA)
        .mockResolvedValueOnce(null);

      await fakeAdapter.addDomain("shop.mamasmarket.com");
      const result = await addDomainToStore("store-a", "shop.mamasmarket.com");
      expect(result).toEqual({
        ok: false,
        error: "Domain is already in use by another project",
        status: 409,
      });
    });
  });

  describe("getDomainStatus", () => {
    it("returns verification status for store with domain", async () => {
      mockFindUnique.mockResolvedValueOnce({
        ...storeA,
        customDomain: "shop.mamasmarket.com",
      });
      await fakeAdapter.addDomain("shop.mamasmarket.com");

      const result = await getDomainStatus("store-a");
      expect(result).toEqual({
        ok: true,
        domain: "shop.mamasmarket.com",
        verified: false,
        cname: "cname.vercel-dns.com",
      });
    });

    it("returns verified: true after verification", async () => {
      mockFindUnique.mockResolvedValueOnce({
        ...storeA,
        customDomain: "shop.mamasmarket.com",
      });
      await fakeAdapter.addDomain("shop.mamasmarket.com");
      fakeAdapter.setVerified("shop.mamasmarket.com", true);

      const result = await getDomainStatus("store-a");
      expect(result).toEqual({
        ok: true,
        domain: "shop.mamasmarket.com",
        verified: true,
        cname: "cname.vercel-dns.com",
      });
    });

    it("returns 404 when store has no domain", async () => {
      mockFindUnique.mockResolvedValueOnce(storeA);

      const result = await getDomainStatus("store-a");
      expect(result).toEqual({
        ok: false,
        error: "Store has no custom domain",
        status: 404,
      });
    });

    it("returns 404 when store not found", async () => {
      mockFindUnique.mockResolvedValueOnce(null);

      const result = await getDomainStatus("nonexistent");
      expect(result).toEqual({
        ok: false,
        error: "Store not found",
        status: 404,
      });
    });
  });

  describe("removeDomainFromStore", () => {
    it("removes domain from store and Vercel", async () => {
      mockFindUnique.mockResolvedValueOnce({
        ...storeA,
        customDomain: "shop.mamasmarket.com",
      });
      mockUpdate.mockResolvedValueOnce(storeA);
      await fakeAdapter.addDomain("shop.mamasmarket.com");

      const result = await removeDomainFromStore("store-a");
      expect(result).toEqual({
        ok: true,
        domain: "shop.mamasmarket.com",
        verified: false,
        cname: "cname.vercel-dns.com",
      });
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: "store-a" },
        data: { customDomain: null },
      });
    });

    it("returns 404 when store has no domain", async () => {
      mockFindUnique.mockResolvedValueOnce(storeA);

      const result = await removeDomainFromStore("store-a");
      expect(result).toEqual({
        ok: false,
        error: "Store has no custom domain",
        status: 404,
      });
    });

    it("still removes from DB if Vercel returns 404", async () => {
      mockFindUnique.mockResolvedValueOnce({
        ...storeA,
        customDomain: "shop.mamasmarket.com",
      });
      mockUpdate.mockResolvedValueOnce(storeA);

      const result = await removeDomainFromStore("store-a");
      expect(result.ok).toBe(true);
      expect(mockUpdate).toHaveBeenCalled();
    });
  });
});
