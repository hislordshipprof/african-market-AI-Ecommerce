import { Package, Truck, Store } from "lucide-react";
import type { ValidatedStore } from "@/lib/get-store";

export function PromoBand({ store }: { store: ValidatedStore }) {
  return (
    <section
      data-testid="promo-band"
      className="rounded-lg bg-primary-deep px-6 py-8 text-on-primary sm:px-10"
    >
      <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-display text-lg font-bold sm:text-xl">
            Why shop with {store.name}?
          </h2>
          <ul className="mt-4 space-y-3">
            <li className="flex items-center gap-3 font-body text-sm text-on-primary/90">
              <Package className="h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
              Fresh from source &mdash; direct imports every week
            </li>
            <li className="flex items-center gap-3 font-body text-sm text-on-primary/90">
              <Truck className="h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
              {store.deliveryInfo || "Local delivery available"}
            </li>
            <li className="flex items-center gap-3 font-body text-sm text-on-primary/90">
              <Store className="h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
              Real store prices &mdash; no platform markup
            </li>
          </ul>
        </div>

        {store.hours && typeof store.hours === "object" && (
          <div className="shrink-0 rounded-md bg-white/10 px-5 py-4">
            <h3 className="mb-2 font-label text-xs uppercase tracking-wider text-on-primary/70">
              Store hours
            </h3>
            <dl className="space-y-1 font-body text-sm text-on-primary/90">
              {Object.entries(store.hours as Record<string, string>).map(
                ([day, time]) => (
                  <div key={day} className="flex justify-between gap-4">
                    <dt className="capitalize">{day}</dt>
                    <dd className="text-right">{time}</dd>
                  </div>
                ),
              )}
            </dl>
          </div>
        )}
      </div>
    </section>
  );
}
