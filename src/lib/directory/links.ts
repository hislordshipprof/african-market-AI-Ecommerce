import { fallbackRootHost, isSlugRoutable } from "@/lib/slug";

type Env = Record<string, string | undefined>;

/**
 * The store's own storefront: a subdomain of the root domain the directory is served on, or, on the
 * production alias that stands in until that domain is chosen, `?store=<slug>` on the alias (#766).
 */
export function storefrontUrl(slug: string, requestHost: string, env: Env = process.env): string | null {
  if (!isSlugRoutable(slug)) return null;
  const alias = fallbackRootHost(env);
  if (alias) return `https://${alias}/?store=${slug}`;
  const root = (env.PLATFORM_ROOT_DOMAIN ?? "").toLowerCase();
  const port = requestHost.split(":")[1];
  const local = root === "localhost";
  return `${local ? "http" : "https"}://${slug}.${root}${local && port ? `:${port}` : ""}/`;
}

/** The directory's own origin, for sitemap and canonical URLs. Pages cached for every request cannot read the host. */
export function directoryOrigin(env: Env = process.env): string {
  const alias = fallbackRootHost(env);
  if (alias) return `https://${alias}`;
  const root = (env.PLATFORM_ROOT_DOMAIN ?? "").toLowerCase();
  return root === "localhost" ? `http://localhost${env.PORT ? `:${env.PORT}` : ""}` : `https://${root}`;
}
