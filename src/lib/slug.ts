export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "www",
  "admin",
  "api",
  "app",
  "mail",
  "static",
  "assets",
  "cdn",
  "vercel",
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Every slug-rejection rule lives here. validateStoreFields and slugFromHost both call this.
export function isSlugRoutable(slug: string): boolean {
  if (!SLUG_RE.test(slug)) return false;
  if (RESERVED_SLUGS.has(slug)) return false;
  if (/^\d+$/.test(slug)) return false;
  if (slug === "localhost") return false;
  return true;
}

export function slugFromHost(
  host: string,
  rootDomain?: string,
): string | null {
  const hostname = host.split(":")[0].toLowerCase();

  if (hostname.endsWith(".vercel.app")) return null;

  if (rootDomain) {
    const root = rootDomain.toLowerCase();
    if (hostname === root || hostname === `www.${root}`) return null;
    if (hostname.endsWith(`.${root}`)) {
      const sub = hostname.slice(0, -(root.length + 1)) || null;
      if (!sub || !isSlugRoutable(sub)) return null;
      return sub;
    }
  }

  const firstLabel = hostname.split(".")[0];
  if (!firstLabel || !isSlugRoutable(firstLabel)) return null;

  return firstLabel;
}
