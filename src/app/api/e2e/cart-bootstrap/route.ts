import { NextResponse } from "next/server";
import { assistantFakeAllowed } from "@/lib/assistant/contract";
import {
  cartBootstrapWaiting,
  holdCartBootstrap,
  releaseCartBootstrap,
} from "@/lib/cart/bootstrap";

/** Test barrier for the first cart create. Closed unless the assistant e2e fake is allowed. */
export async function POST(request: Request) {
  if (!assistantFakeAllowed()) {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }
  const body = await request.json().catch(() => null) as { action?: string; key?: string } | null;
  const key = typeof body?.key === "string" ? body.key : "";
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });
  if (body?.action === "hold") holdCartBootstrap(key);
  else if (body?.action === "release") releaseCartBootstrap(key);
  else if (body?.action !== "status") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  return NextResponse.json({ waiting: cartBootstrapWaiting(key) });
}
