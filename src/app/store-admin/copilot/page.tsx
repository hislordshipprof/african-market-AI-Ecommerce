import Link from "next/link";
import { Store } from "lucide-react";
import { requireStoreOwner } from "@/lib/store-admin/session";
import { listOpenAlerts } from "@/lib/copilot/alerts";
import { loadDigestHour } from "@/lib/copilot/digest";
import { listPendingOwnerReports } from "@/lib/copilot/owner-report";
import { loadCopilotPanel } from "@/lib/copilot/turn";
import { AlertsPanel } from "./alerts-panel";
import { CopilotPanel } from "./copilot-panel";
import { DigestSetting } from "./digest-setting";
import { OwnerReportPanel } from "./owner-report-panel";

export default async function CopilotPage() {
  const session = await requireStoreOwner();
  const [panel, alerts, digestHour, reports] = await Promise.all([
    loadCopilotPanel(session.store.id, session.user.id),
    listOpenAlerts(session.store.id),
    loadDigestHour(session.store.id),
    listPendingOwnerReports(session.store.id),
  ]);

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <Link
            href={`/store-admin?store=${session.store.slug}`}
            className="flex min-h-11 items-center gap-2 rounded-lg bg-primary px-3 text-primary-foreground"
          >
            <Store className="size-5" />
            <span className="text-sm font-semibold">Dashboard</span>
          </Link>
          <div>
            <h1 className="text-base font-semibold text-foreground">{session.store.name}</h1>
            <p className="text-xs text-muted-foreground">Stock copilot</p>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-6">
        <AlertsPanel alerts={alerts} />
        <CopilotPanel
          conversationId={panel.conversationId}
          messages={panel.messages}
          proposals={panel.proposals}
          voiceAndPhoto={<OwnerReportPanel reports={reports} embedded />}
          voiceAndPhotoWaiting={reports.length}
        />
        <DigestSetting hour={digestHour} />
      </main>
    </div>
  );
}
