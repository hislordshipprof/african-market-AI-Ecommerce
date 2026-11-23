import { money } from "@/lib/format";

export function PriceDisplay({
  cents,
  prefix,
  className,
  weightG,
  unit = "item",
}: {
  cents: number;
  prefix?: string;
  className?: string;
  weightG?: number;
  unit?: string;
}) {
  const dollars = Math.floor(Math.abs(cents) / 100);
  const remainder = Math.abs(cents) % 100;

  return (
    <span className={`sf-price ${className ?? ""}`}>
      <span aria-label={`${prefix ?? ""}${money(cents)}`}>
        <span aria-hidden="true">
          {prefix}
          {cents < 0 ? "−" : ""}${dollars}
          <sup>{String(remainder).padStart(2, "0")}</sup>
        </span>
      </span>
      <small>
        {weightG && weightG > 0
          ? `${money((cents * 100) / weightG)} / 100 g`
          : `${money(cents)} / ${unit}`}
      </small>
    </span>
  );
}
