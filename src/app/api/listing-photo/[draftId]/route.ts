import { storeScoped } from "@/lib/db";
import { streamPrivatePhoto } from "@/lib/r2";
import { parseInput } from "@/lib/security/parse-input";
import { requireStoreMember } from "@/lib/store-admin/session";
import { z } from "zod";

function notFound() {
  return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
}

/** A draft's shelf photo, for its own store's members only (the owner frames a product proposal photo from it). */
export async function GET(_request: Request, context: { params: Promise<{ draftId: string }> }) {
  const session = await requireStoreMember();
  const parsed = parseInput(z.string().min(1).max(200), (await context.params).draftId);
  if (!parsed.ok) return notFound();
  const draft = await storeScoped(session.store.id).listingDraft.findUnique({
    where: { id: parsed.data },
    select: { photoKey: true },
  });
  if (!draft) return notFound();
  const photo = await streamPrivatePhoto(draft.photoKey);
  if (!photo) return notFound();
  return new Response(photo.body, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
