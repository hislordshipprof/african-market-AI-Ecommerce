import { NextRequest, NextResponse } from "next/server";
import { slugFromHost, isSlugRoutable } from "@/lib/slug";

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
  let setCookie = false;

  if (overrideAllowed) {
    const paramSlug = request.nextUrl.searchParams.get("store");
    if (paramSlug && isSlugRoutable(paramSlug)) {
      slug = paramSlug;
      setCookie = true;
    } else if (!paramSlug) {
      const cookieSlug = request.cookies.get(COOKIE_NAME)?.value;
      if (cookieSlug && isSlugRoutable(cookieSlug)) {
        slug = cookieSlug;
      }
    }
  }

  if (!slug && host) {
    slug = slugFromHost(host, process.env.PLATFORM_ROOT_DOMAIN);
  }

  if (slug) {
    headers.set("x-store-slug", slug);
  }

  const response = NextResponse.next({ request: { headers } });

  if (setCookie && slug) {
    response.cookies.set(COOKIE_NAME, slug, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
      secure: request.nextUrl.protocol === "https:",
    });
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
