import { ExternalLink } from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  paid: "Paid",
  pending: "Pending",
  in_transit: "On the way",
  canceled: "Cancelled",
  failed: "Failed",
};

export const payoutStatus = (status: string) => STATUS_LABELS[status] ?? status;

// Stripe gives the arrival date as midnight UTC of the bank day.
const arrival = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const arrivalDate = (seconds: number) => arrival.format(new Date(seconds * 1000));

/** Posts to the server, which makes a one-time Stripe login link and redirects to it. */
export function StripeDashboardButton({ slug }: { slug: string }) {
  return (
    <form method="post" action={`/store-admin/payouts/stripe-dashboard?store=${encodeURIComponent(slug)}`}>
      <button
        type="submit"
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        Open Stripe dashboard
        <ExternalLink className="size-4" aria-hidden />
      </button>
    </form>
  );
}

export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      {children}
    </p>
  );
}
