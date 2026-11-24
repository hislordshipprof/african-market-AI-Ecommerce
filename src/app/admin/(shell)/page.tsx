import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getAdminHomeCounts, type QueueCount } from "@/lib/admin/home-counts";
import { requirePlatformAdmin } from "@/lib/admin/session";
import { missingSetup } from "@/lib/health";

export const metadata = { title: "Home — Platform Admin" };

/** What each missing setup turns off (#765); the names are the env variables, never their values. */
const SETUP_EFFECT: Record<string, string> = {
  EMAIL_FROM: "Sign-in links and order emails reach no one. Shoppers and staff are told email sign-in is not available yet.",
  R2_PROOF_BUCKET: "Store delivery and shipping are hidden at checkout: delivery photos and labels have nowhere to be kept.",
  SHIPPO_API_KEY: "Shipping is hidden at checkout: labels cannot be bought.",
};

type Queue = { href: string; label: string; counted: QueueCount | null; detail: string; testId: string };

export default async function AdminHome() {
  await requirePlatformAdmin();
  const counts = await getAdminHomeCounts();

  const queues: Queue[] = [
    { href: "/admin/orders", label: "Refunds to resolve", counted: counts.refunds, detail: "Refunds that failed and are still owed", testId: "count-refunds" },
    { href: "/admin/orders/check", label: "Orders to check", counted: counts.ordersToCheck, detail: "Stuck orders and payment alerts", testId: "count-orders-to-check" },
    { href: "/admin/support", label: "Escalated messages", counted: counts.messages, detail: "Threads waiting on the platform team", testId: "count-messages" },
    { href: "/admin/catalog/review", label: "Catalog review", counted: counts.catalogReview, detail: "Products awaiting review", testId: "count-catalog-review" },
  ];
  const waiting = queues.filter((queue) => (queue.counted?.count ?? 0) > 0).length;
  const unloaded = queues.some((queue) => !queue.counted);
  const missing = missingSetup(process.env);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:py-12">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Home</h1>
      <p className="mt-1 text-muted-foreground">
        {waiting > 0
          ? `${waiting} of ${queues.length} queues have work waiting.`
          : unloaded
            ? "Some counts could not be loaded."
            : "Every queue is clear."}
      </p>

      {missing.length > 0 && (
        <section aria-labelledby="missing-setup">
          <h2 id="missing-setup" className="mb-3 mt-8 text-sm font-semibold text-muted-foreground">Missing setup</h2>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {missing.map((name) => (
              <li key={name} className="px-4 py-4 sm:px-5">
                <code className="block font-mono text-sm font-semibold text-foreground">{name}</code>
                <span className="mt-1 block text-sm text-muted-foreground">{SETUP_EFFECT[name]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2 className="mb-3 mt-8 text-sm font-semibold text-muted-foreground">Queues</h2>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {queues.map((queue) => (
          <li key={queue.href}>
            <QueueLink {...queue} />
          </li>
        ))}
      </ul>

      <h2 className="mb-3 mt-8 text-sm font-semibold text-muted-foreground">Stores</h2>
      <Link
        href="/admin/stores"
        data-testid="count-stores"
        className="group flex min-h-16 items-center gap-4 rounded-xl border border-border bg-card px-4 py-4 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:px-5"
      >
        {counts.stores ? (
          <span className="flex-1 text-foreground">
            <span className="font-heading text-2xl font-bold tabular-nums">{counts.stores.active}</span> active
            <span className="mx-3 text-border" aria-hidden>|</span>
            <span className={`font-heading text-2xl font-bold tabular-nums ${counts.stores.suspended === 0 ? "text-muted-foreground" : ""}`}>
              {counts.stores.suspended}
            </span>{" "}
            suspended
          </span>
        ) : (
          <span className="flex-1 text-muted-foreground">Couldn&apos;t load the store count</span>
        )}
        <ChevronRight aria-hidden className="size-5 text-muted-foreground group-hover:text-foreground" />
      </Link>
    </div>
  );
}

function QueueLink({ href, label, counted, detail, testId }: Queue) {
  const clear = counted?.count === 0;
  return (
    <Link
      href={href}
      data-testid={testId}
      className="group flex min-h-16 items-center gap-4 px-4 py-4 hover:bg-muted focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring sm:px-5"
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-foreground">{label}</span>
        <span className="block text-sm text-muted-foreground">
          {!counted ? "Couldn't load the count" : clear ? "Nothing waiting" : detail}
        </span>
      </span>
      {counted && (
        <span
          className={`font-heading text-[28px] font-bold leading-none tabular-nums ${clear ? "text-muted-foreground" : "text-foreground"}`}
        >
          {counted.incomplete && <span className="sr-only">At least </span>}
          {counted.count}
          {counted.incomplete && <span aria-hidden>+</span>}
        </span>
      )}
      <ChevronRight aria-hidden className="size-5 shrink-0 text-muted-foreground group-hover:text-foreground" />
    </Link>
  );
}
