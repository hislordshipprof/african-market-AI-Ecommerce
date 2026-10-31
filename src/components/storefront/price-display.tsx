export function PriceDisplay({
  cents,
  prefix,
  className,
}: {
  cents: number;
  prefix?: string;
  className?: string;
}) {
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;

  return (
    <span className={className}>
      {prefix}${dollars}
      {remainder > 0 && (
        <sup className="relative -top-[0.4em] text-[0.65em] font-semibold tracking-tight">
          {String(remainder).padStart(2, "0")}
        </sup>
      )}
    </span>
  );
}
