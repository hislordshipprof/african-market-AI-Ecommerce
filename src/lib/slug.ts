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
      if (sub && RESERVED_SLUGS.has(sub)) return null;
      return sub;
    }
  }

  const firstLabel = hostname.split(".")[0];
  if (
    !firstLabel ||
    firstLabel === "localhost" ||
    RESERVED_SLUGS.has(firstLabel) ||
    /^\d+$/.test(firstLabel)
  ) {
    return null;
  }

  return firstLabel;
}
