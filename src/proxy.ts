import { NextRequest, NextResponse } from "next/server";
import { slugFromHost } from "@/lib/slug";

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete("x-store-slug");

  const host = request.headers.get("host");
  let slug: string | null = null;

  if (
    process.env.VERCEL_ENV === "preview" ||
    process.env.NODE_ENV === "development"
  ) {
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
