import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { streamFromR2 } from "@/lib/r2";
import { parseInput } from "@/lib/security/parse-input";
import { isSvgPath, SVG_CSP } from "@/lib/security/headers";

const keySchema = z.array(z.string().min(1).max(512)).min(1).max(8);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const { key: segments } = await params;
  const parsed = parseInput(keySchema, segments);
  if (!parsed.ok || parsed.data.some((segment) => segment.includes("..") || segment.includes("\\"))) {
    return new NextResponse(null, { status: 404 });
  }
  const key = parsed.data.join("/");

  const result = await streamFromR2(key);
  if (!result) {
    return new NextResponse(null, { status: 404 });
  }

  const headers: Record<string, string> = {
    "Content-Type": result.contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": SVG_CSP,
  };
  const contentType = result.contentType.toLowerCase();
  if (isSvgPath(key) || !contentType.startsWith("image/") || contentType.includes("svg")) {
    // <img> ignores this; a directly opened SVG or non-image downloads instead of rendering.
    headers["Content-Disposition"] = "attachment";
  }
  return new NextResponse(result.body, { headers });
}
