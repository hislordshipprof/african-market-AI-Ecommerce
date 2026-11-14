import { allowStoreOverride } from "../../proxy";
import { resolveAuthBaseUrl } from "../auth";
import { isSlugRoutable } from "../slug";

/**
 * The link in a customer message.
 * Production with a root domain uses the store subdomain.
 * `?store=` is only where the proxy honours it.
 * Otherwise there is no link, and the message is not sent.
 */
export function orderTrackingUrl(
  store: { slug: string },
  token: string,
  env: Record<string, string | undefined>,
  subpath: "" | "/substitutions" = "",
): string | null {
  if (!token) return null;
  return storePageUrl(store, `/order/${encodeURIComponent(token)}${subpath}`, env);
}

/** A page on the store's own host, by the same rules as the tracking link. */
export function storePageUrl(
  store: { slug: string },
  path: string,
  env: Record<string, string | undefined>,
): string | null {
  if (!isSlugRoutable(store.slug)) return null;
  const root = env.PLATFORM_ROOT_DOMAIN?.trim();
  if (root) return `https://${store.slug}.${root}${path}`;
  if (!allowStoreOverride(env)) return null;
  const base = resolveAuthBaseUrl(env).replace(/\/$/, "");
  return `${base}${path}?store=${encodeURIComponent(store.slug)}`;
}
