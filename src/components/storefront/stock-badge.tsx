import type { StockBadge } from "@/lib/storefront/stock-badge";

const config: Record<StockBadge, { label: string; className: string }> = {
  "in-stock": {
    label: "In stock",
    className: "bg-success/15 text-[color:color-mix(in_srgb,var(--color-success)_65%,var(--color-ink))]",
  },
  limited: {
    label: "Limited",
    className: "bg-[color:var(--color-deal)]/10 text-[color:color-mix(in_srgb,var(--color-deal)_65%,var(--color-ink))]",
  },
  "ask-store": {
    label: "Ask store",
    className: "bg-muted text-muted-foreground",
  },
};

export function StockBadgeChip({ badge }: { badge: StockBadge }) {
  const { label, className } = config[badge];
  return (
    <span
      data-testid="stock-badge"
      className={`inline-flex items-center rounded-pill px-2 py-0.5 font-label text-[13px] font-semibold leading-tight ${className}`}
    >
      {label}
    </span>
  );
}
