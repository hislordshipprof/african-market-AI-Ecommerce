/** How long ago `since` was at `now`, for admin lists: "45 min", "3 h 5 min", "2 d 4 h". */
export function formatAge(since: Date, now: number): string {
  const minutes = Math.max(0, Math.floor((now - since.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}
