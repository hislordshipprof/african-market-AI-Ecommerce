import { isSlugRoutable } from "@/lib/slug";

/** The store's own storefront, as a subdomain of the root domain the directory is served on. */
export function storefrontUrl(slug: string, rootDomain: string, requestHost: string): string | null {
  if (!isSlugRoutable(slug)) return null;
  const root = rootDomain.toLowerCase();
  const port = requestHost.split(":")[1];
  const local = root === "localhost";
  return `${local ? "http" : "https"}://${slug}.${root}${local && port ? `:${port}` : ""}/`;
}

/** The directory's own origin, for sitemap and canonical URLs. Pages cached for every request cannot read the host. */
export function directoryOrigin(env: Record<string, string | undefined> = process.env): string {
  const root = (env.PLATFORM_ROOT_DOMAIN ?? "").toLowerCase();
  return root === "localhost" ? `http://localhost${env.PORT ? `:${env.PORT}` : ""}` : `https://${root}`;
}
