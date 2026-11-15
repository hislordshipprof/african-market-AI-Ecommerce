import type { IncidentKind } from "@/lib/admin/courier-incidents-query";
import type { DeliveryProviderName } from "@/lib/delivery/provider";

export const KIND_LABELS: Record<IncidentKind, string> = {
  failover: "Failover",
  both_failed: "Both couriers failed",
  provider_cancelled: "Courier cancelled",
  returned: "Returned to store or failed",
  assigned_late: "Assigned after the timeout",
  delivered_no_proof: "Delivered with no proof",
};

export const PROVIDER_LABELS: Record<DeliveryProviderName, string> = { doordash: "DoorDash Drive", uber: "Uber Direct" };

export const EVENT_LABELS: Record<string, string> = {
  courier_assigned: "Courier assigned",
  picked_up: "Picked up",
  delivered: "Delivered",
  cancelled: "Cancelled",
  returned: "Returned to store",
  failover_triggered: "Failover started",
  both_failed: "Both couriers failed",
  out_for_delivery: "Out for delivery",
};

export const STATE_LABELS = { open: "Open", resolved: "Resolved" } as const;

export function providersText(providers: DeliveryProviderName[]): string {
  return providers.length === 0 ? "None booked" : providers.map((p) => PROVIDER_LABELS[p] ?? p).join(", then ");
}

export function kindsText(kinds: IncidentKind[]): string {
  return kinds.map((k) => KIND_LABELS[k]).join(", ");
}

const UTC_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });

export function utcTime(at: Date): string {
  return `${UTC_TIME.format(at)} UTC`;
}

export function StateLabel({ state }: { state: "open" | "resolved" }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
        state === "open" ? "border-foreground text-foreground" : "border-dashed border-border text-muted-foreground"
      }`}
    >
      {STATE_LABELS[state]}
    </span>
  );
}
