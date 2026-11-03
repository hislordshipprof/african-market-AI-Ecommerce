import { NextRequest, NextResponse } from "next/server";
import { findRecentMagicLinkVerifications } from "@/lib/db";

/**
 * Test-only token lookup. Closed on Vercel and in production.
 * Local Playwright runs `next start` (NODE_ENV=production) with
 * VERCEL_ENV=preview and without VERCEL, matching allowStoreOverride.
 */
export function magicLinkTokenRouteAllowed(
  env: Record<string, string | undefined>,
): boolean {
  if (env.E2E_STORE_OVERRIDE !== "1") return false;
  if (env.VERCEL) return false;
  if (env.VERCEL_ENV === "production") return false;
  if (env.NODE_ENV === "production" && env.VERCEL_ENV !== "preview") return false;
  return true;
}

export async function GET(req: NextRequest) {
  if (!magicLinkTokenRouteAllowed(process.env)) {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  const email = req.nextUrl.searchParams.get("email");
  if (!email) {
    return NextResponse.json({ error: "email required" }, { status: 400 });
  }

  const rows = await findRecentMagicLinkVerifications();

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value);
      if (parsed.email === email) {
        return NextResponse.json({
          token: row.identifier.replace("magic-link:", ""),
        });
      }
    } catch {
      if (row.value === email) {
        return NextResponse.json({
          token: row.identifier.replace("magic-link:", ""),
        });
      }
    }
  }

  return NextResponse.json({ error: "no verification found" }, { status: 404 });
}
