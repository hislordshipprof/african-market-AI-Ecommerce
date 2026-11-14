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
      <span aria-label={`${prefix ?? ""}$${(cents / 100).toFixed(2)}`}>
        <span aria-hidden="true">
          {prefix}
          {cents < 0 ? "−" : ""}${dollars}
          <sup>{String(remainder).padStart(2, "0")}</sup>
        </span>
      </span>
      <small>
        {weightG && weightG > 0
          ? `$${(cents / weightG).toFixed(2)} / 100 g`
          : `$${(cents / 100).toFixed(2)} / ${unit}`}
      </small>
    </span>
  );
}
