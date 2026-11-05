export const BROWSER_COOKIE = "shop_browser";
const BROWSER_ID = /^[A-Za-z0-9_-]{8,80}$/;

export function readBrowserId(header: string | null, cookieHeader: string | null): string | null {
  const fromHeader = header?.trim() ?? "";
  if (BROWSER_ID.test(fromHeader)) return fromHeader;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== BROWSER_COOKIE) continue;
    const value = decodeURIComponent(rest.join("="));
    return BROWSER_ID.test(value) ? value : null;
  }
  return null;
}
