import { listStoreRequestAreas } from "@/lib/admin/store-requests";
import { STATE_NAMES } from "@/lib/directory/us-states";

export const metadata = { title: "Store requests — Platform Admin" };

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Shoppers with no store within 50 miles who asked to hear when one opens (#455): onboarding leads by area. */
export default async function StoreRequestsPage() {
  const areas = await listStoreRequestAreas();
  const waiting = areas.reduce((sum, area) => sum + area.zips.reduce((n, zip) => n + zip.waiting, 0), 0);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:py-12">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Store requests</h1>
      <p className="mt-1 max-w-prose text-muted-foreground">
        Shoppers who found no store within 50 miles and asked to hear when one opens. Each gets one message when a listed store is within 50 miles of their ZIP, and their contact is then deleted. The state comes from the ZIP; the place is the nearest Census place in that state.
      </p>

      {areas.length === 0 ? (
        <div className="mt-6 rounded-lg border border-border bg-card p-8 text-center">
          <p className="text-muted-foreground">No requests yet.</p>
        </div>
      ) : (
        <>
          <p className="mt-6 text-sm font-medium text-foreground" data-testid="store-requests-waiting">
            {waiting === 1 ? "1 shopper waiting" : `${waiting} shoppers waiting`}
          </p>
          {areas.map((area) => (
            <section key={area.state} aria-labelledby={`state-${area.state}`} className="mt-6">
              <h2 id={`state-${area.state}`} className="mb-2 text-lg font-semibold text-foreground">
                {STATE_NAMES[area.state]}
              </h2>
              <div className="overflow-x-auto rounded-lg border border-border bg-card">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border bg-muted">
                    <tr>
                      <th scope="col" className="px-3 py-3 sm:px-4 font-medium text-muted-foreground">ZIP</th>
                      <th scope="col" className="px-3 py-3 sm:px-4 font-medium text-muted-foreground">Near</th>
                      <th scope="col" className="px-3 py-3 sm:px-4 text-right font-medium text-muted-foreground">Waiting</th>
                      <th scope="col" className="px-3 py-3 sm:px-4 text-right font-medium text-muted-foreground">Told</th>
                      <th scope="col" className="px-3 py-3 sm:px-4 font-medium text-muted-foreground">Latest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {area.zips.map((zip) => (
                      <tr key={zip.zip} className="border-b border-border last:border-0">
                        <td className="px-3 py-3 sm:px-4 font-mono text-foreground">{zip.zip}</td>
                        <td className="px-3 py-3 sm:px-4 text-foreground">{zip.place ?? "—"}</td>
                        <td className="px-3 py-3 sm:px-4 text-right font-medium tabular-nums text-foreground">{zip.waiting}</td>
                        <td className="px-3 py-3 sm:px-4 text-right tabular-nums text-muted-foreground">{zip.notified}</td>
                        <td className="px-3 py-3 sm:px-4 text-muted-foreground">{day.format(zip.latest)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
