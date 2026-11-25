import { requireStoreOwner } from "@/lib/store-admin/session";
import { listOpenAlerts } from "@/lib/copilot/alerts";
import { loadDigestHour } from "@/lib/copilot/digest";
import { listPendingOwnerReports } from "@/lib/copilot/owner-report";
import { inventoryReport } from "@/lib/copilot/inventory-report";
import { listWeeklyReports } from "@/lib/copilot/weekly-report";
import { AlertsPanel } from "./alerts-panel";
import { DigestSetting } from "./digest-setting";
import { OwnerReportPanel } from "./owner-report-panel";
import { StockMovement } from "./stock-movement";
import { WeeklyReports } from "./weekly-reports";
import { ReorderPanel } from "./reorder-panel";
import { reorderSuggestions } from "@/lib/copilot/reorder";
import { loadReorderList, reorderText } from "@/lib/copilot/reorder-list";
import { PlanLocked } from "@/components/store-admin/plan-locked";
import { storeMayUse } from "@/lib/billing/plan";
import { PageHeader } from "@/app/store-admin/shell/page-header";

export default async function CopilotPage() {
  const session = await requireStoreOwner();
  const [alerts, digestHour, reports, reportsAllowed, movement, reorderAllowed, weekly] = await Promise.all([
    listOpenAlerts(session.store.id),
    loadDigestHour(session.store.id),
    listPendingOwnerReports(session.store.id),
    storeMayUse(session.store.id, "copilot-reports"),
    inventoryReport(session.store.id),
    storeMayUse(session.store.id, "reorder-suggestions"),
    listWeeklyReports(session.store.id),
  ]);
  const [reorder, savedList] = reorderAllowed
    ? await Promise.all([reorderSuggestions(session.store.id), loadReorderList(session.store.id)])
    : [null, null];

  return (
    <>
      <PageHeader title="Stock copilot" description={session.store.name} />
      <div className="max-w-3xl">
        <AlertsPanel alerts={alerts} />
        {/* The chat is the Store assistant button on every store-admin page (#855). */}
        {reportsAllowed ? (
          <OwnerReportPanel reports={reports} />
        ) : (
          <section aria-labelledby="voice-photo-title" className="mt-10 flex flex-col gap-4 border-t border-border pt-8">
            <h2 id="voice-photo-title" className="font-display text-[1.375rem] leading-tight font-bold text-foreground">Report stock by voice or photo</h2>
            <PlanLocked
              title="Voice and photo stock reports"
              description="Say what came in, or snap the invoice or shelf, and the copilot drafts the stock changes."
              storeSlug={session.store.slug}
            />
          </section>
        )}
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
        <WeeklyReports reports={weekly} />
        <DigestSetting hour={digestHour} />
      </div>
    </>
  );
}
