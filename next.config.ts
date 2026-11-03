import type { NextConfig } from "next";

const logoHosts = (process.env.LOGO_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "3mb",
    },
  },
  images: {
    // SVG logos are rendered with a plain <img> (StoreLogo), never via the optimizer (#60).
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
