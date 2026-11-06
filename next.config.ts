import type { NextConfig } from "next";

const logoHosts = (process.env.LOGO_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdfjs-dist", "sharp"],
  experimental: {
    serverActions: {
      bodySizeLimit: "3mb",
    },
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
