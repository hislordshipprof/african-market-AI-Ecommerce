import { isSlugRoutable } from "@/lib/slug";

/** The store's own storefront, as a subdomain of the root domain the directory is served on. */
export function storefrontUrl(slug: string, rootDomain: string, requestHost: string): string | null {
  if (!isSlugRoutable(slug)) return null;
  const root = rootDomain.toLowerCase();
  const port = requestHost.split(":")[1];
  const local = root === "localhost";
  return `${local ? "http" : "https"}://${slug}.${root}${local && port ? `:${port}` : ""}/`;
}
