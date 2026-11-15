import Link from "next/link";
import { Check, Circle } from "lucide-react";

export interface GoLiveItemView {
  key: string;
  label: string;
  detail: string;
  done: boolean;
  /** Where the store fixes it, when the store can. */
  href?: string;
}

/** The go-live checklist rows (#555), shared by the store-admin home and the platform admin's store page. */
export function GoLiveItems({ items }: { items: GoLiveItemView[] }) {
  return (
    <ul className="divide-y divide-border" aria-label="Go-live checklist">
      {items.map((item) => (
        <li key={item.key} className="flex items-start gap-3 py-3" data-testid={`go-live-${item.key}`} data-done={item.done}>
          <span
            className={
              item.done
                ? "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
                : "mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground"
            }
            aria-hidden
          >
            {item.done ? <Check className="size-3.5" strokeWidth={3} /> : <Circle className="size-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              {item.label}
              <span className="sr-only">{item.done ? " (done)" : " (to do)"}</span>
            </p>
            <p className="break-words text-sm text-muted-foreground">{item.detail}</p>
          </div>
          {!item.done && item.href && (
            <Link
              href={item.href}
              className="inline-flex min-h-11 shrink-0 items-center px-1 text-sm font-medium text-primary underline underline-offset-4"
            >
              Fix<span className="sr-only"> {item.label}</span>
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}
