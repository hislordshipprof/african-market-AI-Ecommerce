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

type Env = Record<string, string | undefined>;

// One label under vercel.app: Vercel names the production URL after the shortest custom domain once
// one is attached, and store domains are attached to this project (#711), so only an alias qualifies.
const VERCEL_ALIAS_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/;

/**
 * The production vercel.app alias, served as the platform root until PLATFORM_ROOT_DOMAIN is set (#766).
 * Stores are not subdomains there: they are reached by `?store=<slug>` (ADR-0007).
 */
export function fallbackRootHost(env: Env): string | null {
  if (env.PLATFORM_ROOT_DOMAIN?.trim()) return null;
  if (env.VERCEL_ENV !== "production") return null;
  const alias = env.VERCEL_PROJECT_PRODUCTION_URL?.trim().toLowerCase() ?? "";
  return VERCEL_ALIAS_RE.test(alias) ? alias : null;
}

export function isFallbackRoot(host: string, env: Env): boolean {
  const alias = fallbackRootHost(env);
  return alias !== null && host.split(":")[0].toLowerCase() === alias;
}

export function slugFromHost(
  host: string,
  rootDomain?: string,
): string | null {
  const result = resolveHost(host, rootDomain);
  if (result.kind === "slug") return result.slug;
  return null;
}
