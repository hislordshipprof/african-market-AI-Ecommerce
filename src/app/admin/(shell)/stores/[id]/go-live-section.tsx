import { forceGoLiveAction } from "@/lib/admin/actions";
import { FORCE_REASON_MAX } from "@/lib/go-live/service";
import { goLiveItemLabel, readGoLiveChecklist } from "@/lib/go-live/checklist";
import { GoLiveItems } from "@/components/go-live/go-live-items";

const STATUS_TEXT: Record<string, string> = {
  setup: "Setup: shoppers see “Opening soon” and checkout is off.",
  active: "Live: the store takes orders.",
  suspended: "Suspended: the storefront is offline. Suspension wins over going live.",
};

/** Store status and, while in setup, the go-live checklist with a forced go live that needs a reason (#555). */
export async function GoLiveSection({ storeId, forced, error }: { storeId: string; forced: boolean; error?: string }) {
  const checklist = await readGoLiveChecklist(storeId, new Date());
  if (!checklist) return null;
  const open = checklist.items.filter((i) => !i.done).length;

  return (
    <section aria-labelledby="go-live" className="mb-8 rounded-lg border border-border bg-card p-5">
      <h2 id="go-live" className="text-base font-semibold text-foreground">Go live</h2>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="store-status">
        {STATUS_TEXT[checklist.status] ?? checklist.status}
      </p>
      {forced && !error && <p role="status" className="mt-2 text-sm text-foreground">The store is live. The reason is in the audit log.</p>}
      {checklist.status === "setup" && (
        <>
          <div className="mt-3">
            <GoLiveItems
              items={checklist.items.map((item) => ({ ...item, label: goLiveItemLabel(item.key, checklist.floor) }))}
            />
          </div>
          <form action={forceGoLiveAction} className="mt-4 border-t border-border pt-4">
            <input type="hidden" name="storeId" value={storeId} />
            <p className="text-sm text-muted-foreground">
              {open === 0
                ? "Every item is done. The owner can go live from their dashboard, or you can go live for them."
                : `${open} ${open === 1 ? "item is" : "items are"} still open. The owner's Go live stays off until they are done.`}
            </p>
            <div className="mt-3 grid gap-1.5">
              <label htmlFor="go-live-reason" className="text-sm font-medium text-foreground">Reason</label>
              <textarea
                id="go-live-reason"
                name="reason"
                required
                maxLength={FORCE_REASON_MAX}
                rows={2}
                placeholder="For example: launch partner, Stripe review finishes tonight"
                className="min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
            </div>
            <button
              type="submit"
              className="mt-3 min-h-11 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Go live now
            </button>
          </form>
        </>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </section>
  );
}
