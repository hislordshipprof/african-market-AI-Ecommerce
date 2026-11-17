import { describe, expect, it } from "vitest";
import {
  enforcedPolicy,
  imageHosts,
  NO_SCRIPT_CSP,
  reportOnlyPolicy,
  staticSecurityHeaders,
} from "./headers";

describe("security headers", () => {
  it("enforced policy: default-src self, real allow-lists, reports to /api/csp-report", () => {
    const enforced = enforcedPolicy({ NODE_ENV: "production", R2_PUBLIC_URL: "https://cdn.example.test" });
    const directive = (name: string) => enforced.split("; ").find((d) => d.startsWith(`${name} `));
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("connect-src")).toBe("connect-src 'self' https://api.stripe.com");
    expect(directive("frame-src")).toBe("frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com");
    expect(directive("img-src")).toContain("https://cdn.example.test");
    // The payouts dashboard form is answered with a 303 to connect.stripe.com; form-action covers redirects.
    expect(directive("form-action")).toBe("form-action 'self' https://connect.stripe.com");
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("report-uri")).toBe("report-uri /api/csp-report");
    // script-src is not tightened until nonces: Next's inline scripts must still run.
    expect(directive("script-src")).toContain("'unsafe-inline'");
    expect(enforced).not.toContain("nonce-");
    expect(enforced).not.toContain("unsafe-eval");
    expect(enforced).not.toContain("maps.googleapis.com");

    const headers = staticSecurityHeaders({ NODE_ENV: "production" });
    const value = (key: string) => headers.find((header) => header.key === key)?.value;
    expect(value("Content-Security-Policy")).toBe(enforcedPolicy({ NODE_ENV: "production" }));
  });

  it("HSTS covers subdomains without preload; Permissions-Policy limits device and payment APIs", () => {
    const headers = staticSecurityHeaders({ NODE_ENV: "production" });
    const value = (key: string) => headers.find((header) => header.key === key)?.value;
    expect(value("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
    expect(value("Permissions-Policy")).toBe('camera=(), microphone=(), geolocation=(self), payment=(self "https://js.stripe.com")');
  });

  it("report-only policy keeps the nonce experiment and reports too", () => {
    const policy = reportOnlyPolicy("abc", { NODE_ENV: "production" });
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).toContain("'nonce-abc'");
    expect(policy).toContain("https://js.stripe.com");
    expect(policy).toContain("https://hooks.stripe.com");
    expect(policy).toContain("https://api.stripe.com");
    expect(policy).not.toContain("maps.googleapis.com");
    expect(policy).toContain("report-uri /api/csp-report");
  });

  it("the SVG policy has exactly one script-src, and it is 'none' (#124)", () => {
    expect(NO_SCRIPT_CSP.match(/script-src[^;]*/g)).toEqual(["script-src 'none'"]);
    expect(NO_SCRIPT_CSP).toContain("sandbox");
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
