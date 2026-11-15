import { platformAdminApiDenial } from "@/lib/admin/session";
import { platformAdminTransaction } from "@/lib/db";
import { streamPrivatePhoto } from "@/lib/r2";
import { parseInput } from "@/lib/security/parse-input";
import { z } from "zod";

function notFound() {
  return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
}

/** A product proposal's cropped photo, for platform admins reviewing it; it is public only once approved. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await platformAdminApiDenial();
  if (denied) return denied;
  const parsed = parseInput(z.string().min(1).max(200), (await context.params).id);
  if (!parsed.ok) return notFound();
  const proposal = await platformAdminTransaction((tx) => tx.productProposal.findUnique({
    where: { id: parsed.data },
    select: { photoKey: true },
  }));
  if (!proposal?.photoKey) return notFound();
  const photo = await streamPrivatePhoto(proposal.photoKey);
  if (!photo) return notFound();
  return new Response(photo.body, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
