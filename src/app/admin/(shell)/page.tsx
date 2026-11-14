import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getAdminHomeCounts } from "@/lib/admin/home-counts";
import { requirePlatformAdmin } from "@/lib/admin/session";

export const metadata = { title: "Home — Platform Admin" };

type Queue = { href: string; label: string; count: number; detail: string; incomplete?: boolean; testId: string };

export default async function AdminHome() {
  await requirePlatformAdmin();
  const counts = await getAdminHomeCounts();
  const { active, suspended } = counts.stores;

  const queues: Queue[] = [
    { href: "/admin/orders", label: "Refunds to resolve", count: counts.refunds, detail: "Refunds that failed and are still owed", testId: "count-refunds" },
    {
      href: "/admin/orders/check",
      label: "Orders to check",
      count: counts.ordersToCheck.count,
      incomplete: counts.ordersToCheck.incomplete,
      detail: "Stuck orders and payment alerts",
      testId: "count-orders-to-check",
    },
    { href: "/admin/support", label: "Escalated messages", count: counts.messages, detail: "Threads handed to the platform team", testId: "count-messages" },
    { href: "/admin/catalog/review", label: "Catalog review", count: counts.catalogReview, detail: "Products awaiting review", testId: "count-catalog-review" },
  ];
  const waiting = queues.filter((queue) => queue.count > 0).length;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:py-12">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Home</h1>
      <p className="mt-1 text-muted-foreground">
        {waiting === 0 ? "Every queue is clear." : `${waiting} of ${queues.length} queues have work waiting.`}
      </p>

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
        <span className="flex-1 text-foreground">
          <span className="font-heading text-2xl font-bold tabular-nums">{active}</span> active
          <span className="mx-3 text-border" aria-hidden>|</span>
          <span className={`font-heading text-2xl font-bold tabular-nums ${suspended === 0 ? "text-muted-foreground" : ""}`}>{suspended}</span> suspended
        </span>
        <ChevronRight aria-hidden className="size-5 text-muted-foreground group-hover:text-foreground" />
      </Link>
    </div>
  );
}

function QueueLink({ href, label, count, detail, incomplete, testId }: Queue) {
  const clear = count === 0;
  return (
    <Link
      href={href}
      data-testid={testId}
      className="group flex min-h-16 items-center gap-4 px-4 py-4 hover:bg-muted focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring sm:px-5"
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-foreground">{label}</span>
        <span className="block text-sm text-muted-foreground">{clear ? "Nothing waiting" : detail}</span>
      </span>
      <span
        className={`font-heading text-[28px] font-bold leading-none tabular-nums ${clear ? "text-muted-foreground" : "text-foreground"}`}
        aria-label={incomplete ? `At least ${count}` : undefined}
      >
        {count}
        {incomplete && <span aria-hidden>+</span>}
      </span>
      <ChevronRight aria-hidden className="size-5 shrink-0 text-muted-foreground group-hover:text-foreground" />
    </Link>
  );
}
