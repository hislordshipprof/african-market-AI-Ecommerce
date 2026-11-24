import { describe, expect, it } from "vitest";
import { orderTrackingUrl, storePageUrl } from "./tracking-url";

const store = { slug: "mama-ngozi" };
const token = "a".repeat(43);

describe("orderTrackingUrl", () => {
  it("links use the store subdomain in production, ?store= only where the proxy honours it, and no link when production has neither a root domain nor its alias", () => {
    expect(orderTrackingUrl(store, token, {
      NODE_ENV: "production",
      PLATFORM_ROOT_DOMAIN: "markets.example",
    })).toBe(`https://mama-ngozi.markets.example/order/${token}`);

    expect(orderTrackingUrl(store, token, { NODE_ENV: "production" })).toBeNull();

    expect(orderTrackingUrl(store, token, {
      VERCEL_ENV: "preview",
      VERCEL_URL: "preview-abc.vercel.app",
    })).toBe(`https://preview-abc.vercel.app/order/${token}?store=mama-ngozi`);

    expect(orderTrackingUrl(store, token, {
      NODE_ENV: "test",
      E2E_STORE_OVERRIDE: "1",
      BETTER_AUTH_URL: "http://localhost:4200",
    })).toBe(`http://localhost:4200/order/${token}?store=mama-ngozi`);

    expect(orderTrackingUrl({ slug: "admin" }, token, {
      NODE_ENV: "production",
      PLATFORM_ROOT_DOMAIN: "markets.example",
    })).toBeNull();
  });
});

describe("links on the production alias (#796)", () => {
  const alias = "african-market-ai-ecommerce.vercel.app";
  const env = {
    VERCEL: "1",
    NODE_ENV: "production",
    VERCEL_ENV: "production",
    VERCEL_URL: "african-market-ai-ecommerce-h3x9.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: alias,
  };

  it("the tracking and store page links name the store on the alias, which the proxy honours there", () => {
    expect(orderTrackingUrl(store, token, env)).toBe(`https://${alias}/order/${token}?store=mama-ngozi`);
    expect(orderTrackingUrl(store, token, env, "/substitutions")).toBe(`https://${alias}/order/${token}/substitutions?store=mama-ngozi`);
    expect(storePageUrl(store, "/driver/route-token", env)).toBe(`https://${alias}/driver/route-token?store=mama-ngozi`);
    expect(storePageUrl({ slug: "admin" }, "/driver/route-token", env)).toBeNull();
  });

  it("a root domain still wins over the alias", () => {
    expect(orderTrackingUrl(store, token, { ...env, PLATFORM_ROOT_DOMAIN: "markets.example" }))
      .toBe(`https://mama-ngozi.markets.example/order/${token}`);
  });
});
