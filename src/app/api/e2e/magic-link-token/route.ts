import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { findRecentMagicLinkVerifications } from "@/lib/db";
import { parseInput } from "@/lib/security/parse-input";
import { testOnlyRoutesAllowed } from "@/lib/security/test-only-routes";

/**
 * Test-only token lookup. Closed on Vercel and in production unless this
 * is a CI or preview run with the route's own flag. Request values cannot open it.
 */
export function magicLinkTokenRouteAllowed(
  env: Record<string, string | undefined>,
): boolean {
  return testOnlyRoutesAllowed(env, env.E2E_STORE_OVERRIDE);
}

export async function GET(req: NextRequest) {
  if (!magicLinkTokenRouteAllowed(process.env)) {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  const email = parseInput(z.string().min(1).max(320), req.nextUrl.searchParams.get("email") ?? "");
  if (!email.ok) {
    return NextResponse.json({ error: "email required" }, { status: 400 });
  }

  const rows = await findRecentMagicLinkVerifications();

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value);
      if (parsed.email === email.data) {
        return NextResponse.json({
          token: row.identifier.replace("magic-link:", ""),
        });
      }
    } catch {
      if (row.value === email.data) {
        return NextResponse.json({
          token: row.identifier.replace("magic-link:", ""),
        });
      }
    }
  }

  return NextResponse.json({ error: "no verification found" }, { status: 404 });
}
