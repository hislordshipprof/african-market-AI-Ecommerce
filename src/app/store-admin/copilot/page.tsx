import Link from "next/link";
import { Store } from "lucide-react";
import { requireStoreOwner } from "@/lib/store-admin/session";
import { loadCopilotPanel } from "@/lib/copilot/turn";
import { CopilotPanel } from "./copilot-panel";

export default async function CopilotPage() {
  const session = await requireStoreOwner();
  const panel = await loadCopilotPanel(session.store.id, session.user.id);

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <Link
            href={`/store-admin?store=${session.store.slug}`}
            className="flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground"
            aria-label="Back to the dashboard"
          >
            <Store className="size-5" />
          </Link>
          <div>
            <h1 className="text-base font-semibold text-foreground">{session.store.name}</h1>
            <p className="text-xs text-muted-foreground">Stock copilot</p>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-6">
        <CopilotPanel
          conversationId={panel.conversationId}
          messages={panel.messages}
          proposals={panel.proposals}
        />
      </main>
    </div>
  );
}
