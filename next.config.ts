import type { NextConfig } from "next";
import { OLD_AISLE_SLUGS } from "./src/lib/catalog/category-tree";
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
  // Aisles #861 renamed or retired keep their links and search ranking with a permanent redirect.
  async redirects() {
    return Object.entries(OLD_AISLE_SLUGS).map(([from, to]) => ({
      source: `/categories/${from}`,
      destination: `/categories/${to}`,
      statusCode: 301 as const,
    }));
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
