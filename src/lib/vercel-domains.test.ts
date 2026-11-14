import { describe, it, expect, beforeEach } from "vitest";
import {
  FakeVercelDomainsAdapter,
  RealVercelDomainsAdapter,
  VercelApiError,
  createVercelDomainsAdapter,
} from "./vercel-domains";

describe("FakeVercelDomainsAdapter", () => {
  let adapter: FakeVercelDomainsAdapter;

  beforeEach(() => {
    adapter = new FakeVercelDomainsAdapter();
  });

  describe("addDomain", () => {
    it("returns CNAME target and pending status", async () => {
      const result = await adapter.addDomain("shop.mamasmarket.com");
      expect(result).toEqual({
        domain: "shop.mamasmarket.com",
        verified: false,
        cname: "cname.vercel-dns.com",
      });
    });

    it("rejects duplicate domain with 409", async () => {
      await adapter.addDomain("shop.mamasmarket.com");
      await expect(adapter.addDomain("shop.mamasmarket.com")).rejects.toThrow(
        VercelApiError,
      );
      try {
        await adapter.addDomain("shop.mamasmarket.com");
      } catch (e) {
        expect(e).toBeInstanceOf(VercelApiError);
        expect((e as VercelApiError).status).toBe(409);
        expect((e as VercelApiError).code).toBe("domain_already_in_use");
      }
    });
  });

  describe("getDomainConfig", () => {
    it("returns verification status", async () => {
      await adapter.addDomain("shop.mamasmarket.com");
      const result = await adapter.getDomainConfig("shop.mamasmarket.com");
      expect(result.verified).toBe(false);
      expect(result.cname).toBe("cname.vercel-dns.com");
    });

    it("returns verified after setVerified", async () => {
      await adapter.addDomain("shop.mamasmarket.com");
      adapter.setVerified("shop.mamasmarket.com", true);
      const result = await adapter.getDomainConfig("shop.mamasmarket.com");
      expect(result.verified).toBe(true);
    });

    it("throws 404 for unknown domain", async () => {
      await expect(adapter.getDomainConfig("unknown.com")).rejects.toThrow(
        VercelApiError,
      );
      try {
        await adapter.getDomainConfig("unknown.com");
      } catch (e) {
        expect(e).toBeInstanceOf(VercelApiError);
        expect((e as VercelApiError).status).toBe(404);
      }
    });
  });

  describe("removeDomain", () => {
    it("succeeds for existing domain", async () => {
      await adapter.addDomain("shop.mamasmarket.com");
      const result = await adapter.removeDomain("shop.mamasmarket.com");
      expect(result).toEqual({ domain: "shop.mamasmarket.com", removed: true });
    });

    it("throws 404 for unknown domain", async () => {
      await expect(adapter.removeDomain("unknown.com")).rejects.toThrow(
        VercelApiError,
      );
      try {
        await adapter.removeDomain("unknown.com");
      } catch (e) {
        expect(e).toBeInstanceOf(VercelApiError);
        expect((e as VercelApiError).status).toBe(404);
      }
    });

    it("domain is gone after removal", async () => {
      await adapter.addDomain("shop.mamasmarket.com");
      await adapter.removeDomain("shop.mamasmarket.com");
      await expect(
        adapter.getDomainConfig("shop.mamasmarket.com"),
      ).rejects.toThrow(VercelApiError);
    });
  });
});

describe("createVercelDomainsAdapter", () => {
  const keys = { VERCEL_TOKEN: "t", VERCEL_PROJECT_ID: "p" };

  it("uses the fake in test and development when keys are missing", () => {
    expect(createVercelDomainsAdapter({ NODE_ENV: "test" })).toBeInstanceOf(FakeVercelDomainsAdapter);
    expect(createVercelDomainsAdapter({ NODE_ENV: "development" })).toBeInstanceOf(FakeVercelDomainsAdapter);
  });

  it("uses the real adapter whenever the keys are set", () => {
    expect(createVercelDomainsAdapter({ NODE_ENV: "development", ...keys })).toBeInstanceOf(RealVercelDomainsAdapter);
    expect(createVercelDomainsAdapter({ NODE_ENV: "production", VERCEL: "1", ...keys })).toBeInstanceOf(RealVercelDomainsAdapter);
  });

  it("throws in production when keys are missing instead of faking", () => {
    expect(() => createVercelDomainsAdapter({ NODE_ENV: "production" })).toThrow(/VERCEL_TOKEN/);
    expect(() => createVercelDomainsAdapter({ NODE_ENV: "production", VERCEL_TOKEN: "t" })).toThrow(/VERCEL_PROJECT_ID/);
  });

  it("throws on a Vercel deployment with missing keys even if NODE_ENV is not production", () => {
    expect(() => createVercelDomainsAdapter({ NODE_ENV: "development", VERCEL: "1" })).toThrow(/VERCEL_TOKEN/);
  });

  it("throws when only some keys are set in development rather than half-faking", () => {
    expect(() => createVercelDomainsAdapter({ NODE_ENV: "development", VERCEL_TOKEN: "t" })).toThrow(/VERCEL_PROJECT_ID/);
  });
});
