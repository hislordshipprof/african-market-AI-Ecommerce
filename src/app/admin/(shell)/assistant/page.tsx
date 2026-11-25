import { requirePlatformAdmin } from "@/lib/admin/session";
import { adminBriefing } from "@/lib/admin/assistant/briefing";
import { loadAdminAssistantChat } from "@/lib/admin/assistant/turn";
import Link from "next/link";
import { AdminAssistantPanel } from "./assistant-panel";

export default async function AdminAssistantPage() {
  const session = await requirePlatformAdmin();
  const [chat, briefing] = await Promise.all([loadAdminAssistantChat(session.user.id), adminBriefing(new Date())]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold text-foreground">Assistant</h1>
      <p className="mt-2 max-w-[65ch] text-base leading-6 text-muted-foreground">
        Ask about stores, orders, refunds, couriers, applications, messages, disputes, AI spend or the catalogue. It reads the same records as these screens. It can draft a change, such as suspending a store or replying to a customer, but nothing changes until you confirm the card. A refund, a forced go-live or a delete also needs you to type a reason on the card.
      </p>
      <p className="mt-2 text-base">
        <Link href="/admin/assistant/activity" className="font-semibold text-foreground underline underline-offset-4">Assistant activity</Link>
      </p>
      <AdminAssistantPanel conversationId={chat.conversationId} messages={chat.messages} drafts={chat.drafts} briefing={briefing} />
    </div>
  );
}
