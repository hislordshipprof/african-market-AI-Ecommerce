import type { NextConfig } from "next";
import { CSV_ACTION_BODY_LIMIT_BYTES } from "./src/lib/listing/csv-file-cap";
import { staticSecurityHeaders } from "./src/lib/security/headers";

const logoHosts = (process.env.LOGO_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pdfjs-dist", "sharp"],
  experimental: {
    serverActions: {
      bodySizeLimit: CSV_ACTION_BODY_LIMIT_BYTES,
    },
  },
  async headers() {
    const headers = staticSecurityHeaders();
    return [
      { source: "/:path*", headers },
      { source: "/", headers },
      { source: "/_next/static/:path*", headers },
      // The driver's route link (#566): the token is the key, so the page is never indexed or cached.
      {
        source: "/driver/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
      // Every order detail view is audited (#537): no browser cache or back-forward cache copy.
      { source: "/admin/orders/search/:orderId", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
    ];
  },
  images: {
    // SVG logos are rendered with a plain <img> (StoreLogo), never via the optimizer (#60).
    // search is exact. Omitting it would allow any query string (#208).
    localPatterns: [
      { pathname: "/**", search: "" },
      { pathname: "/api/catalog-image/**", search: "?retry=1" },
      { pathname: "/images/products/**", search: "?retry=1" },
    ],
    dangerouslyAllowSVG: false,
    contentDispositionType: "attachment",
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    remotePatterns: [
      ...new Set([...logoHosts, "images.unsplash.com", ...(process.env.R2_PUBLIC_URL ? [new URL(process.env.R2_PUBLIC_URL).hostname] : [])]),
    ].map((hostname) => ({
      protocol: "https" as const,
      hostname,
    })),
  },
};

export default nextConfig;
