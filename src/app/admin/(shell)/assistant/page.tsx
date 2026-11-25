import { requirePlatformAdmin } from "@/lib/admin/session";
import { loadAdminAssistantChat } from "@/lib/admin/assistant/turn";
import { AdminAssistantPanel } from "./assistant-panel";

export default async function AdminAssistantPage() {
  const session = await requirePlatformAdmin();
  const chat = await loadAdminAssistantChat(session.user.id);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold text-foreground">Assistant</h1>
      <p className="mt-2 max-w-[65ch] text-base leading-6 text-muted-foreground">
        Ask about stores, orders, refunds, couriers, applications, messages, disputes, AI spend or the catalogue. It reads the same records as these screens and changes nothing.
      </p>
      <AdminAssistantPanel conversationId={chat.conversationId} messages={chat.messages} />
    </div>
  );
}
