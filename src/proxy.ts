import { NextRequest, NextResponse } from "next/server";
import { BROWSER_COOKIE } from "@/lib/cart/browser";
import { resolveHost, isSlugRoutable, isFallbackRoot } from "@/lib/slug";
import { ATTRIBUTION_COOKIE, ATTRIBUTION_MAX_AGE, DIRECTORY_REF } from "@/lib/directory/attribution";
import { needsNoScriptCsp, newCspNonce, NO_SCRIPT_CSP, reportOnlyPolicy, staticSecurityHeaders } from "@/lib/security/headers";

const COOKIE_NAME = "store_override";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export function allowStoreOverride(
  env: Record<string, string | undefined>,
): boolean {
  if (env.VERCEL_ENV === "preview") return true;
  if (env.NODE_ENV === "development") return true;
  if (env.E2E_STORE_OVERRIDE === "1" && !env.VERCEL) return true;
  return false;
}

export function proxy(request: NextRequest) {
  const host = request.headers.get("host");
  const fallbackRoot = host !== null && isFallbackRoot(host, process.env);
  const response = route(request, host, fallbackRoot);
  // The stand-in address must never compete with the real domain in search (#766).
  if (fallbackRoot) response.headers.set("X-Robots-Tag", "noindex");
  return response;
}

function route(request: NextRequest, host: string | null, fallbackRoot: boolean): NextResponse {
  const headers = new Headers(request.headers);
  headers.delete("x-store-slug");
  headers.delete("x-custom-domain");
  headers.delete("x-platform-root");
  // Lets store admin send a signed-out member back to the page they asked for (#797).
  headers.set("x-request-path", request.nextUrl.pathname + request.nextUrl.search);

  // The alias has no store subdomains, so stores are reached there the way previews reach them (#766).
  const overrideAllowed = fallbackRoot || allowStoreOverride(process.env);
  // The directory home and a store's home are both "/" there: a marketplace page forgets the store,
  // so the marketplace's own links to "/" lead home.
  const forgetsStore = fallbackRoot && isMarketplacePath(request.nextUrl.pathname);
  let slug: string | null = null;

  if (overrideAllowed) {
    const rawParam = request.nextUrl.searchParams.get("store");
    const paramSlug = rawParam?.toLowerCase() ?? null;
    if (paramSlug && isSlugRoutable(paramSlug)) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.searchParams.delete("store");
      const response = NextResponse.redirect(redirectUrl, 307);
      stampSecurity(headers, response);
      rememberBrowser(request, response, browserIdentity(request));
      response.cookies.set(COOKIE_NAME, paramSlug, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: COOKIE_MAX_AGE,
        secure: request.nextUrl.protocol === "https:",
      });
      return response;
    }

    const cookieSlug = request.cookies.get(COOKIE_NAME)?.value;
    if (cookieSlug && isSlugRoutable(cookieSlug) && !forgetsStore) {
      slug = cookieSlug;
    }
  }

  if (!slug && fallbackRoot) {
    headers.set("x-platform-root", "1");
  } else if (!slug && host) {
    const resolution = resolveHost(host, process.env.PLATFORM_ROOT_DOMAIN);
    if (resolution.kind === "slug") {
      slug = resolution.slug;
    } else if (resolution.kind === "custom-domain") {
      headers.set("x-custom-domain", resolution.hostname);
    } else if (resolution.kind === "root") {
      headers.set("x-platform-root", "1");
    }
  }

  if (slug) {
    headers.set("x-store-slug", slug);
  }

  // State and city pages are cached for every host, so only the root domain may reach them (#451).
  if (isDirectoryOnlyPath(request.nextUrl.pathname) && headers.get("x-platform-root") !== "1") {
    const response = NextResponse.rewrite(new URL("/_directory-not-here", request.url), { request: { headers } });
    stampSecurity(headers, response);
    return response;
  }

  const browserId = browserIdentity(request);
  headers.set("x-shop-browser", browserId);
  const policy = reportOnlyPolicy(newCspNonce(), process.env);
  headers.set("content-security-policy-report-only", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy-report-only", policy);
  for (const header of staticSecurityHeaders()) {
    response.headers.set(header.key, header.value);
  }
  if (needsNoScriptCsp(request.nextUrl.pathname)) {
    response.headers.set("Content-Security-Policy", NO_SCRIPT_CSP);
  }
  rememberBrowser(request, response, browserId);
  if (headers.get("x-platform-root") !== "1" && request.nextUrl.searchParams.get("ref") === DIRECTORY_REF) {
    response.cookies.set(ATTRIBUTION_COOKIE, DIRECTORY_REF, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: ATTRIBUTION_MAX_AGE,
      secure: request.nextUrl.protocol === "https:",
    });
  }
  // A prefetch is not a visit: a store page's link to a marketplace page must not forget the store (#797).
  if (forgetsStore && request.cookies.has(COOKIE_NAME) && !isPrefetch(request)) {
    response.cookies.set(COOKIE_NAME, "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
      secure: request.nextUrl.protocol === "https:",
    });
  }
  return response;
}

function isDirectoryOnlyPath(pathname: string): boolean {
  return pathname === "/sitemap.xml" || pathname === "/robots.txt" || pathname.startsWith("/stores/");
}

/**
 * Pages of the platform itself, which a store remembered on the alias must not take over.
 * Password reset is shared with store admin, so it keeps the store (#797).
 */
function isMarketplacePath(pathname: string): boolean {
  if (pathname === "/admin/reset-password") return false;
  return isDirectoryOnlyPath(pathname) || pathname === "/sell" || pathname === "/admin" || pathname.startsWith("/admin/");
}

function isPrefetch(request: NextRequest): boolean {
  const purpose = request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "";
  return request.headers.get("next-router-prefetch") === "1" || purpose.includes("prefetch");
}

function stampSecurity(requestHeaders: Headers, response: NextResponse) {
  const policy = reportOnlyPolicy(newCspNonce(), process.env);
  requestHeaders.set("content-security-policy-report-only", policy);
  response.headers.set("content-security-policy-report-only", policy);
  for (const header of staticSecurityHeaders()) {
    response.headers.set(header.key, header.value);
  }
}

function browserIdentity(request: NextRequest): string {
  const existing = request.cookies.get(BROWSER_COOKIE)?.value ?? "";
  return /^[A-Za-z0-9_-]{8,80}$/.test(existing)
    ? existing
    : crypto.randomUUID().replace(/-/g, "");
}

function rememberBrowser(request: NextRequest, response: NextResponse, id: string) {
  if (request.cookies.get(BROWSER_COOKIE)?.value === id) return;
  response.cookies.set(BROWSER_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    secure: request.nextUrl.protocol === "https:",
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
