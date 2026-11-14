import type { MetadataRoute } from "next";
import { directoryOrigin } from "@/lib/directory/links";

// Root domain only (the proxy 404s it on store hosts, which keep their current crawl rules) (#451).
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/"] },
    sitemap: `${directoryOrigin()}/sitemap.xml`,
  };
}
