import Link from "next/link";
import { ChevronLeft } from "lucide-react";

/**
 * A store-admin page's title row (#860). The sidebar replaces the old back arrow to the dashboard; `parent`
 * is only for a page inside another one (a past order, a payout), and leads back to that list.
 */
export function PageHeader({
  title,
  description,
  actions,
  parent,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Buttons and toggles beside the title; they wrap under it on phones. */
  actions?: React.ReactNode;
  parent?: { href: string; label: string };
  /** Anything under the title row that belongs to the header, such as a problems strip. */
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-6 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          {parent && (
            <Link
              href={parent.href}
              className="-ml-1 mb-1 inline-flex min-h-11 items-center gap-1 rounded-lg px-1 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 sm:min-h-8"
            >
              <ChevronLeft className="size-4" aria-hidden />
              {parent.label}
            </Link>
          )}
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground sm:text-base">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
