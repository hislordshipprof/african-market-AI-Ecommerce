import { notFound, redirect } from "next/navigation";
import { conversationHref, parseChatKey } from "@/lib/admin/ai-review";

/** Old links to one chat open it in the review inbox (#856). */
export default async function AiConversationRedirect({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await params;
  const chat = parseChatKey(`${kind}:${decodeURIComponent(id)}`);
  if (!chat) notFound();
  redirect(conversationHref(chat.kind, chat.id));
}
