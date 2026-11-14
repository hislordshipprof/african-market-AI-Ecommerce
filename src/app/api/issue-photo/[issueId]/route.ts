import { storeScoped } from "@/lib/db";
import { issueIdSchema } from "@/lib/order/issue-review";
import { streamIssuePhoto } from "@/lib/r2";
import { parseInput } from "@/lib/security/parse-input";
import { requireStoreMember } from "@/lib/store-admin/session";

function notFound() {
  return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
}

/** The customer's issue photo is for the store's members only: never by tracking token. */
export async function GET(_request: Request, context: { params: Promise<{ issueId: string }> }) {
  const session = await requireStoreMember();
  const { issueId } = await context.params;
  const parsed = parseInput(issueIdSchema, issueId);
  if (!parsed.ok) return notFound();
  const issue = await storeScoped(session.store.id).issueReport.findUnique({
    where: { id: parsed.data },
    select: { photoKey: true },
  });
  if (!issue?.photoKey) return notFound();
  const photo = await streamIssuePhoto(issue.photoKey);
  if (!photo) return notFound();
  return new Response(photo.body, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
