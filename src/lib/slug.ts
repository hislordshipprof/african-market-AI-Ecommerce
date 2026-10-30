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
      return hostname.slice(0, -(root.length + 1)) || null;
    }
  }

  const firstLabel = hostname.split(".")[0];
  if (
    !firstLabel ||
    firstLabel === "localhost" ||
    firstLabel === "www" ||
    /^\d+$/.test(firstLabel)
  ) {
    return null;
  }

  return firstLabel;
}
