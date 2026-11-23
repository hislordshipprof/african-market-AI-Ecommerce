/** Bar heights divide by `max`, floored at 1 cent; `peakCents` is null when no day sold anything. */
export function dayChartScale(days: Array<{ netCents: number }>): { max: number; peakCents: number | null } {
  const best = Math.max(0, ...days.map((d) => d.netCents));
  return { max: Math.max(1, best), peakCents: best > 0 ? best : null };
}
