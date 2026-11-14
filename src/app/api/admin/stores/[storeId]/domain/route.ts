import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { platformAdminApiDenial } from "@/lib/admin/session";
import {
  addDomainToStore,
  getDomainStatus,
  removeDomainFromStore,
  type DomainResult,
} from "@/lib/domain-service";
import { parseInput } from "@/lib/security/parse-input";
import { requireSameOrigin } from "@/lib/security/same-origin";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ storeId: string }> };

const storeIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

const bodySchema = z.strictObject({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/),
});

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

async function storeIdFrom(ctx: Ctx): Promise<string | null> {
  const parsed = parseInput(storeIdSchema, (await ctx.params).storeId);
  return parsed.ok ? parsed.data : null;
}

function toResponse(result: DomainResult) {
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({
    domain: result.domain,
    verified: result.verified,
    cname: result.cname,
  });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const denied = await platformAdminApiDenial();
  if (denied) return denied;
  if (!requireSameOrigin(req)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const storeId = await storeIdFrom(ctx);
  if (!storeId) return badRequest("Invalid store id");

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const body = parseInput(bodySchema, raw);
  if (!body.ok) return badRequest("Invalid domain format");

  return toResponse(await addDomainToStore(storeId, body.data.domain));
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const denied = await platformAdminApiDenial();
  if (denied) return denied;

  const storeId = await storeIdFrom(ctx);
  if (!storeId) return badRequest("Invalid store id");

  return toResponse(await getDomainStatus(storeId));
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const denied = await platformAdminApiDenial();
  if (denied) return denied;
  if (!requireSameOrigin(req)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const storeId = await storeIdFrom(ctx);
  if (!storeId) return badRequest("Invalid store id");

  const result = await removeDomainFromStore(storeId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ removed: true });
}
