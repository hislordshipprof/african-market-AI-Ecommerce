import { NextRequest, NextResponse } from "next/server";
import {
  addDomainToStore,
  getDomainStatus,
  removeDomainFromStore,
} from "@/lib/domain-service";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await params;

  let body: { domain?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { domain } = body;
  if (!domain || typeof domain !== "string") {
    return NextResponse.json(
      { error: "Missing or invalid domain" },
      { status: 400 },
    );
  }

  const domainLower = domain.toLowerCase().trim();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domainLower)) {
    return NextResponse.json(
      { error: "Invalid domain format" },
      { status: 400 },
    );
  }

  const result = await addDomainToStore(storeId, domainLower);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    domain: result.domain,
    verified: result.verified,
    cname: result.cname,
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await params;

  const result = await getDomainStatus(storeId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    domain: result.domain,
    verified: result.verified,
    cname: result.cname,
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await params;

  const result = await removeDomainFromStore(storeId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ removed: true });
}
