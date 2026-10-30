import { NextRequest, NextResponse } from "next/server";
import { slugFromHost } from "@/lib/slug";

export function allowStoreOverride(
  env: Record<string, string | undefined>,
): boolean {
  if (env.VERCEL_ENV === "preview") return true;
  if (env.NODE_ENV === "development") return true;
  return false;
}

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete("x-store-slug");

  const host = request.headers.get("host");
  let slug: string | null = null;

  if (allowStoreOverride(process.env)) {
    slug = request.nextUrl.searchParams.get("store") ?? null;
  }

  if (!slug && host) {
    slug = slugFromHost(host, process.env.PLATFORM_ROOT_DOMAIN);
  }

  if (slug) {
    headers.set("x-store-slug", slug);
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
