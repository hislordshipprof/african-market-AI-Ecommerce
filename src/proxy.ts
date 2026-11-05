import { NextRequest, NextResponse } from "next/server";
import { BROWSER_COOKIE } from "@/lib/cart/browser";
import { slugFromHost, isSlugRoutable } from "@/lib/slug";
import { newCspNonce, reportOnlyPolicy, staticSecurityHeaders } from "@/lib/security/headers";

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
  const headers = new Headers(request.headers);
  headers.delete("x-store-slug");

  const host = request.headers.get("host");
  const overrideAllowed = allowStoreOverride(process.env);
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
    if (cookieSlug && isSlugRoutable(cookieSlug)) {
      slug = cookieSlug;
    }
  }

  if (!slug && host) {
    slug = slugFromHost(host, process.env.PLATFORM_ROOT_DOMAIN);
  }

  if (slug) {
    headers.set("x-store-slug", slug);
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
  rememberBrowser(request, response, browserId);
  return response;
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
