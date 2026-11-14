import { describe, expect, it } from "vitest";
import { orderTrackingUrl } from "./tracking-url";

const store = { slug: "mama-ngozi" };
const token = "a".repeat(43);

describe("orderTrackingUrl", () => {
  it("links use the store subdomain in production, ?store= only where the proxy honours it, and no link when production has no root domain", () => {
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
