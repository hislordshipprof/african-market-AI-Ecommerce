import { NextRequest, NextResponse } from "next/server";
import { healthQueryRaw } from "@/lib/db";
import { runHealthChecks } from "@/lib/health";
import { isRateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429 },
    );
  }

  const { status, body } = await runHealthChecks({
    env: process.env as Record<string, string | undefined>,
    queryRaw: healthQueryRaw,
  });

  return NextResponse.json(body, { status });
}
