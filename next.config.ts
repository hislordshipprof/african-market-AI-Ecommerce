import type { NextConfig } from "next";
import { CSV_ACTION_BODY_LIMIT_BYTES } from "./src/lib/listing/csv-file-cap";
import { staticSecurityHeaders } from "./src/lib/security/headers";

const logoHosts = (process.env.LOGO_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
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
      // The driver's route link (#566): the token is the key, so it is never indexed, cached or sent on as a referrer.
      {
        source: "/driver/:path*",
        headers: [
          ...headers.filter((header) => header.key !== "Referrer-Policy"),
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
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
