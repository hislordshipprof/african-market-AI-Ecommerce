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

export type HostResolution =
  | { kind: "slug"; slug: string }
  | { kind: "custom-domain"; hostname: string }
  | { kind: "root" }
  | { kind: "none" };

export function resolveHost(
  host: string,
  rootDomain?: string,
): HostResolution {
  const hostname = host.split(":")[0].toLowerCase();
  const root = rootDomain?.toLowerCase();

  // Before the vercel.app and localhost rules: the directory is demoed on a vercel.app root.
  if (root && (hostname === root || hostname === `www.${root}`)) return { kind: "root" };
  if (hostname.endsWith(".vercel.app")) return { kind: "none" };
  if (hostname === "localhost") return { kind: "none" };

  if (root) {
    if (hostname.endsWith(`.${root}`)) {
      const sub = hostname.slice(0, -(root.length + 1)) || null;
      if (!sub || !isSlugRoutable(sub)) return { kind: "none" };
      return { kind: "slug", slug: sub };
    }
    return { kind: "custom-domain", hostname };
  }

  const firstLabel = hostname.split(".")[0];
  if (!firstLabel || !isSlugRoutable(firstLabel)) return { kind: "none" };
  return { kind: "slug", slug: firstLabel };
}

export function slugFromHost(
  host: string,
  rootDomain?: string,
): string | null {
  const result = resolveHost(host, rootDomain);
  if (result.kind === "slug") return result.slug;
  return null;
}
