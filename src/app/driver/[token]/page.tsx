import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getStore } from "@/lib/get-store";
import { readDriverRoute } from "@/lib/delivery/driver-route";
import { RouteStops } from "./route-stops";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Delivery route",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/** The store's own driver's route (#566): no login, the link's token is the only key. */
export default async function DriverRoutePage({ params }: { params: Promise<{ token: string }> }) {
  const [{ token }, store] = await Promise.all([params, getStore()]);
  const route = await readDriverRoute(store.id, token);
  if (!route) notFound();
  const done = route.stops.filter((stop) => stop.status === "DELIVERED").length;
  const ends = route.expiresAt.toLocaleTimeString("en-US", { timeZone: store.timezone, hour: "numeric", minute: "2-digit" });

  return (
    <main className="mx-auto min-h-dvh max-w-xl bg-background px-4 pb-16 pt-6 text-foreground">
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">{route.storeName}</p>
        <h1 className="font-display text-2xl font-bold leading-tight">{route.slotLabel}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {route.driverName} · {done} of {route.stops.length} delivered · link works until {ends === "12:00 AM" ? "midnight" : ends}
        </p>
      </header>
      {route.stops.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          No stops left on this route.
        </p>
      ) : (
        <RouteStops token={token} stops={route.stops} />
      )}
    </main>
  );
}
