import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/assistant/client-ip";
import { healthQueryRaw } from "@/lib/db";
import { runHealthChecks, toMinimalResult } from "@/lib/health";
import { isRateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ip = clientIp(req.headers);

  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const { status, body } = await runHealthChecks({
    env: process.env as Record<string, string | undefined>,
    queryRaw: healthQueryRaw,
  });

  const responseBody =
    process.env.VERCEL_ENV === "production"
      ? toMinimalResult(status, body)
      : body;

  return NextResponse.json(responseBody, { status });
}
