import Link from "next/link";
import { Store } from "lucide-react";
import { requireStoreOwner } from "@/lib/store-admin/session";
import { listOpenAlerts } from "@/lib/copilot/alerts";
import { loadDigestHour } from "@/lib/copilot/digest";
import { listPendingOwnerReports } from "@/lib/copilot/owner-report";
import { inventoryReport } from "@/lib/copilot/inventory-report";
import { loadCopilotPanel } from "@/lib/copilot/turn";
import { AlertsPanel } from "./alerts-panel";
import { CopilotPanel } from "./copilot-panel";
import { DigestSetting } from "./digest-setting";
import { OwnerReportPanel } from "./owner-report-panel";
import { StockMovement } from "./stock-movement";
import { ReorderPanel } from "./reorder-panel";
import { reorderSuggestions } from "@/lib/copilot/reorder";
import { loadReorderList, reorderText } from "@/lib/copilot/reorder-list";
import { PlanLocked } from "@/components/store-admin/plan-locked";
import { storeMayUse } from "@/lib/billing/plan";

export default async function CopilotPage() {
  const session = await requireStoreOwner();
  const [panel, alerts, digestHour, reports, reportsAllowed, movement, reorderAllowed] = await Promise.all([
    loadCopilotPanel(session.store.id, session.user.id),
    listOpenAlerts(session.store.id),
    loadDigestHour(session.store.id),
    listPendingOwnerReports(session.store.id),
    storeMayUse(session.store.id, "copilot-reports"),
    inventoryReport(session.store.id),
    storeMayUse(session.store.id, "reorder-suggestions"),
  ]);
  const [reorder, savedList] = reorderAllowed
    ? await Promise.all([reorderSuggestions(session.store.id), loadReorderList(session.store.id)])
    : [null, null];

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
          voiceAndPhoto={
            reportsAllowed ? (
              <OwnerReportPanel reports={reports} embedded />
            ) : (
              <PlanLocked
                title="Voice and photo stock reports"
                description="Say what came in, or snap the invoice or shelf, and the copilot drafts the stock changes."
                storeSlug={session.store.slug}
              />
            )
          }
          voiceAndPhotoWaiting={reports.length}
        />
        <StockMovement rows={movement.rows} totals={movement.totals} />
        <section aria-labelledby="reorder-title" className="mt-8 flex flex-col gap-3">
          <div>
            <h2 id="reorder-title" className="font-display text-[1.375rem] leading-tight font-bold text-balance text-foreground">
              Reorder suggestions
            </h2>
            {reorder ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {`Enough to last ${reorder.leadDays} days until the delivery arrives and ${reorder.coverDays} days after, at the pace of the last 28 days. Sales are online orders plus the counter sales you report. Edit the numbers and save a list to send your wholesaler. Nothing is ordered and no stock changes.`}
              </p>
            ) : null}
          </div>
          {reorder ? (
            <ReorderPanel
              key={`${reorder.leadDays}-${reorder.coverDays}-${savedList?.savedAt.toISOString() ?? ""}`}
              rows={reorder.rows}
              leadDays={reorder.leadDays}
              coverDays={reorder.coverDays}
              storeSlug={session.store.slug}
              saved={savedList ? { savedAt: savedList.savedAt.toISOString(), items: savedList.items, text: reorderText(savedList, session.store.name) } : null}
            />
          ) : (
            <PlanLocked
              title="Reorder suggestions"
              description="See what to reorder from your sales and stock, edit the numbers, and save a list to print or send."
              storeSlug={session.store.slug}
            />
          )}
        </section>
        <DigestSetting hour={digestHour} />
      </main>
    </div>
  );
}
