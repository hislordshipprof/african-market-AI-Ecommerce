const ORIGIN = "http://store-admin.invalid";
const TWO_FACTOR_PAGE = "/store-admin/two-factor";

/** A store admin page on this site, other than sign-in, or null. */
function storeAdminPage(path: string | null): string | null {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN) return null;
  if (url.pathname !== "/store-admin" && !url.pathname.startsWith("/store-admin/")) return null;
  if (url.pathname.startsWith("/store-admin/sign-in") || url.pathname.startsWith(TWO_FACTOR_PAGE)) return null;
  return url.pathname + url.search;
}

/** Where a signed-out member is sent: the store's sign-in, carrying the page they asked for (#797). */
export function storeSignInPath(slug: string, requestPath: string | null): string {
  const signIn = `/store-admin/sign-in?store=${encodeURIComponent(slug)}`;
  const next = storeAdminPage(requestPath);
  return next && next !== "/store-admin" ? `${signIn}&next=${encodeURIComponent(next)}` : signIn;
}

/** Where sign-in leads: the page asked for, else the store's dashboard. */
export function storeAdminReturnPath(next: string | null, slug: string | null): string {
  return storeAdminPage(next) ?? (slug ? `/store-admin?store=${encodeURIComponent(slug)}` : "/store-admin");
}

/** The store-admin 2FA setup page (#840); `next` is where Set up and Remind me later both lead. */
export function storeTwoFactorPath(slug: string, next: string): string {
  return `${TWO_FACTOR_PAGE}?store=${encodeURIComponent(slug)}&next=${encodeURIComponent(next)}`;
}
