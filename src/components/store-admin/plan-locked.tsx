import Link from "next/link";
import { Lock } from "lucide-react";
import { upgradeHref } from "@/lib/billing/plan";

/** A Pro feature shown locked on Starter, with the upgrade link ADR-0021 asks for. */
export function PlanLocked({
  title,
  description,
  storeSlug,
  canUpgrade = true,
}: {
  title: string;
  description: string;
  storeSlug: string;
  canUpgrade?: boolean;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Lock className="size-5 text-muted-foreground" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {title} <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Pro</span>
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          {canUpgrade ? (
            <Link
              href={upgradeHref(storeSlug)}
              className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-primary underline underline-offset-4"
            >
              Upgrade to Pro
            </Link>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">Ask the store owner to upgrade to Pro.</p>
          )}
        </div>
      </div>
    </div>
  );
}
