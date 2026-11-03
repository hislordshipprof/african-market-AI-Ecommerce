import { NextRequest, NextResponse } from "next/server";
import { findRecentMagicLinkVerifications } from "@/lib/db";

export async function GET(req: NextRequest) {
  if (process.env.E2E_STORE_OVERRIDE !== "1") {
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
