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
): string | null {
  if (!token || !isSlugRoutable(store.slug)) return null;
  const root = env.PLATFORM_ROOT_DOMAIN?.trim();
  if (root) {
    return `https://${store.slug}.${root}/order/${encodeURIComponent(token)}`;
  }
  if (!allowStoreOverride(env)) return null;
  const base = resolveAuthBaseUrl(env).replace(/\/$/, "");
  return `${base}/order/${encodeURIComponent(token)}?store=${encodeURIComponent(store.slug)}`;
}
