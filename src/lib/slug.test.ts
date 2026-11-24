import { describe, it, expect } from "vitest";
import { slugFromHost, resolveHost, RESERVED_SLUGS, isSlugRoutable, isFallbackRoot } from "./slug";

describe("slugFromHost", () => {
  it("extracts slug from subdomain with root domain", () => {
    expect(slugFromHost("mama-ngozi.example.com", "example.com")).toBe(
      "mama-ngozi",
    );
  });

  it("strips port", () => {
    expect(slugFromHost("mama-ngozi.localhost:3000")).toBe("mama-ngozi");
  });

  it("lowercases", () => {
    expect(slugFromHost("Mama-Ngozi.localhost:3000")).toBe("mama-ngozi");
  });

  it("returns null for apex domain", () => {
    expect(slugFromHost("example.com", "example.com")).toBeNull();
  });

  it("returns null for www", () => {
    expect(slugFromHost("www.example.com", "example.com")).toBeNull();
  });

  it("returns null for *.vercel.app", () => {
    expect(slugFromHost("my-app-abc123.vercel.app")).toBeNull();
  });

  it("returns null for bare localhost", () => {
    expect(slugFromHost("localhost:3000")).toBeNull();
  });

  it("returns null for IP address first label", () => {
    expect(slugFromHost("192.168.1.1:3000")).toBeNull();
  });

  it("handles localhost subdomain with root domain", () => {
    expect(slugFromHost("mama-ngozi.localhost:3000", "localhost")).toBe(
      "mama-ngozi",
    );
  });

  it("returns null for all-digit slug with root domain", () => {
    expect(slugFromHost("123.example.com", "example.com")).toBeNull();
  });

  it("returns null for localhost slug with root domain", () => {
    expect(slugFromHost("localhost.example.com", "example.com")).toBeNull();
  });

  it("handles port with root domain", () => {
    expect(slugFromHost("tante-marie.example.com:443", "example.com")).toBe(
      "tante-marie",
    );
  });

  it("returns null for production vercel.app deploy URLs", () => {
    expect(
      slugFromHost("african-markets-platform-git-main.vercel.app"),
    ).toBeNull();
  });

  for (const slug of RESERVED_SLUGS) {
    it(`returns null for reserved slug '${slug}' without root domain`, () => {
      expect(slugFromHost(`${slug}.example.com:3000`)).toBeNull();
    });

    it(`returns null for reserved slug '${slug}' with root domain`, () => {
      expect(slugFromHost(`${slug}.example.com`, "example.com")).toBeNull();
    });
  }
});

describe("isSlugRoutable", () => {
  it("accepts a valid slug", () => {
    expect(isSlugRoutable("mama-ngozi")).toBe(true);
  });

  it("accepts a single-character slug", () => {
    expect(isSlugRoutable("a")).toBe(true);
  });

  it("accepts a slug with numbers and hyphens", () => {
    expect(isSlugRoutable("store-42")).toBe(true);
  });

  it("rejects an all-digit slug", () => {
    expect(isSlugRoutable("123")).toBe(false);
  });

  it("rejects localhost", () => {
    expect(isSlugRoutable("localhost")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isSlugRoutable("")).toBe(false);
  });

  it("rejects a slug with uppercase letters", () => {
    expect(isSlugRoutable("Mama-Ngozi")).toBe(false);
  });

  it("rejects a slug with underscores", () => {
    expect(isSlugRoutable("mama_ngozi")).toBe(false);
  });

  it("rejects a slug starting with a hyphen", () => {
    expect(isSlugRoutable("-mama")).toBe(false);
  });

  it("rejects a slug ending with a hyphen", () => {
    expect(isSlugRoutable("mama-")).toBe(false);
  });

  for (const slug of RESERVED_SLUGS) {
    it(`rejects reserved slug '${slug}'`, () => {
      expect(isSlugRoutable(slug)).toBe(false);
    });
  }
});

describe("resolveHost", () => {
  it("returns slug for subdomain", () => {
    expect(resolveHost("mama-ngozi.example.com", "example.com")).toEqual({
      kind: "slug",
      slug: "mama-ngozi",
    });
  });

  it("returns custom-domain for non-subdomain hostname when root domain is set", () => {
    expect(resolveHost("shop.mamasmarket.com", "example.com")).toEqual({
      kind: "custom-domain",
      hostname: "shop.mamasmarket.com",
    });
  });

  it("returns root for the apex domain, so it serves the directory", () => {
    expect(resolveHost("example.com", "example.com")).toEqual({ kind: "root" });
  });

  it("returns root for www", () => {
    expect(resolveHost("WWW.example.com:443", "example.com")).toEqual({
      kind: "root",
    });
  });

  it("returns root for a vercel.app root domain (the directory demo host)", () => {
    expect(
      resolveHost("african-markets.vercel.app", "african-markets.vercel.app"),
    ).toEqual({ kind: "root" });
  });

  it("returns root for localhost when it is the root domain", () => {
    expect(resolveHost("localhost:3195", "localhost")).toEqual({ kind: "root" });
  });

  it("keeps other vercel.app hosts unresolved when the root is a vercel.app host", () => {
    expect(
      resolveHost("african-markets-git-main.vercel.app", "african-markets.vercel.app"),
    ).toEqual({ kind: "none" });
  });

  it("returns none for vercel.app", () => {
    expect(resolveHost("my-app.vercel.app")).toEqual({ kind: "none" });
  });

  it("returns none for bare localhost", () => {
    expect(resolveHost("localhost:3000")).toEqual({ kind: "none" });
  });

  it("strips port from custom domain", () => {
    expect(resolveHost("shop.mamasmarket.com:443", "example.com")).toEqual({
      kind: "custom-domain",
      hostname: "shop.mamasmarket.com",
    });
  });

  it("lowercases custom domain", () => {
    expect(resolveHost("Shop.MamasMarket.COM", "example.com")).toEqual({
      kind: "custom-domain",
      hostname: "shop.mamasmarket.com",
    });
  });

  it("returns slug without root domain (dev mode)", () => {
    expect(resolveHost("mama-ngozi.localhost:3000")).toEqual({
      kind: "slug",
      slug: "mama-ngozi",
    });
  });
});

describe("RESERVED_SLUGS", () => {
  it("contains www, admin, api, app, mail, static, assets, cdn, vercel", () => {
    for (const slug of ["www", "admin", "api", "app", "mail", "static", "assets", "cdn", "vercel"]) {
      expect(RESERVED_SLUGS.has(slug)).toBe(true);
    }
  });
});

describe("isFallbackRoot (#766): the production alias stands in for the platform root", () => {
  const ALIAS = "african-market-ai-ecommerce.vercel.app";
  const production = { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: ALIAS };

  it("is the production alias while PLATFORM_ROOT_DOMAIN is unset, whatever its case or port", () => {
    expect(isFallbackRoot(ALIAS, production)).toBe(true);
    expect(isFallbackRoot("African-Market-AI-Ecommerce.vercel.app:443", production)).toBe(true);
  });

  it("is not a preview, branch or deployment vercel.app host of the same project", () => {
    for (const host of [
      "african-market-ai-ecommerce-git-main-team.vercel.app",
      "african-market-ai-ecommerce-abc123-team.vercel.app",
    ]) {
      expect(isFallbackRoot(host, production)).toBe(false);
    }
  });

  it("is not a spoofed Host that only contains the alias", () => {
    for (const host of [`${ALIAS}.evil.example`, `mama-ngozi.${ALIAS}`, `evil-${ALIAS}`, "evil.example"]) {
      expect(isFallbackRoot(host, production)).toBe(false);
    }
  });

  it("ends once PLATFORM_ROOT_DOMAIN is set", () => {
    expect(isFallbackRoot(ALIAS, { ...production, PLATFORM_ROOT_DOMAIN: "platform.example" })).toBe(false);
  });

  it("is never a preview deployment, which Vercel also gives the production URL", () => {
    expect(isFallbackRoot(ALIAS, { ...production, VERCEL_ENV: "preview" })).toBe(false);
    expect(isFallbackRoot(ALIAS, { VERCEL_PROJECT_PRODUCTION_URL: ALIAS })).toBe(false);
  });

  it("is never a custom domain, which Vercel picks as the production URL once one is attached (a store's)", () => {
    const env = { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "shop.mamasmarket.com" };
    expect(isFallbackRoot("shop.mamasmarket.com", env)).toBe(false);
  });
});
