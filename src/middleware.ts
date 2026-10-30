import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const host = request.headers.get("host");
  const { searchParams } = request.nextUrl;

  let slug: string | null = null;

  if (process.env.VERCEL_ENV !== "production") {
    slug = searchParams.get("store") ?? null;
  }

  if (!slug && host) {
    const firstLabel = host.split(".")[0];
    if (
      firstLabel &&
      firstLabel !== "localhost" &&
      firstLabel !== "www" &&
      !firstLabel.match(/^\d+$/)
    ) {
      slug = firstLabel;
    }
  }

  const headers = new Headers(request.headers);
  if (slug) {
    headers.set("x-store-slug", slug);
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
