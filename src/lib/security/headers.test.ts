import { describe, expect, it } from "vitest";
import {
  ENFORCED_CSP,
  imageHosts,
  reportOnlyPolicy,
  staticSecurityHeaders,
} from "./headers";

describe("security headers", () => {
  it("baseline enforced, full policy report-only, no unsafe-eval in production", () => {
    const headers = staticSecurityHeaders();
    expect(headers.find((header) => header.key === "Content-Security-Policy")?.value).toBe(ENFORCED_CSP);
    expect(headers.find((header) => header.key === "Strict-Transport-Security")?.value).toBe("max-age=63072000");
    expect(headers.map((header) => header.value).join(" ")).not.toContain("includeSubDomains");
    expect(headers.map((header) => header.value).join(" ")).not.toContain("preload");

    const policy = reportOnlyPolicy("abc", { NODE_ENV: "production" });
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).toContain("'nonce-abc'");
    expect(policy).toContain("https://js.stripe.com");
    expect(policy).toContain("https://hooks.stripe.com");
    expect(policy).toContain("https://api.stripe.com");
    expect(policy).not.toContain("maps.googleapis.com");
    expect(ENFORCED_CSP).toBe("frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  });

  it("optional hosts omitted when unset", () => {
    const bare = reportOnlyPolicy("n", {});
    expect(bare).not.toContain("undefined");
    expect(bare).not.toMatch(/https:\/\/(?:\s|;|$)/);
    expect(imageHosts({})).toEqual([]);
    expect(imageHosts({ R2_PUBLIC_URL: "", LOGO_HOSTS: " , " })).toEqual([]);

    const set = reportOnlyPolicy("n", {
      R2_PUBLIC_URL: "https://cdn.example.test",
      LOGO_HOSTS: "logos.example.test, https://images.example.test",
    });
    expect(set).toContain("https://cdn.example.test");
    expect(set).toContain("https://logos.example.test");
    expect(set).toContain("https://images.example.test");
  });
});
