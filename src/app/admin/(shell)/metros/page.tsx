import Link from "next/link";
import { listMetros, METRO_MAX_STATES, METRO_RADIUS_MI } from "@/lib/admin/metros";
import { requirePlatformAdmin } from "@/lib/admin/session";
import { ASSIGNMENT_TIMEOUT_SECONDS, readCourierSettings } from "@/lib/delivery/courier-settings";
import { MetroForm } from "./metro-form";

export const metadata = { title: "Metros" };

/** Metros (#577): ops groupings of stores with their own courier overrides. Customers never see them. */
export default async function MetrosPage() {
  await requirePlatformAdmin();
  const [metros, platform] = await Promise.all([listMetros(), readCourierSettings()]);

  return (
    <div className="max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Metros</h1>
      <p className="mt-1 max-w-prose text-muted-foreground">
        A metro groups stores for operations: its own courier settings and a readiness report. Shoppers never see it.
      </p>

      {metros.length === 0 ? (
        <p className="mt-8 rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">No metros yet. Add the first one below.</p>
      ) : (
        <ul className="mt-8 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {metros.map((metro) => (
            <li key={metro.id} className="relative flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-muted sm:px-5">
              <Link
                href={`/admin/metros/${metro.id}`}
                className="font-semibold text-foreground underline-offset-4 after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
              >
                {metro.name}
              </Link>
              <span className="text-sm text-muted-foreground tabular-nums">
                {metro.states.join(", ")} · {metro._count.stores === 1 ? "1 store" : `${metro._count.stores} stores`}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-12 text-lg font-semibold text-foreground">New metro</h2>
      <div className="mt-4">
        <MetroForm
          metroId={null}
          metro={null}
          platform={platform}
          limits={{ radius: METRO_RADIUS_MI, timeout: ASSIGNMENT_TIMEOUT_SECONDS, maxStates: METRO_MAX_STATES }}
        />
      </div>
    </div>
  );
}
