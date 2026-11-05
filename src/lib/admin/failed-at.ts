export function failedAtLabel(at: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
  return `${formatted} (${timeZone})`;
}
