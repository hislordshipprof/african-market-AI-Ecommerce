/** The briefing's shape and heading, shared by the page, the chat panel (a client component) and the email (#834). */

export type BriefingKey =
  | "applications"
  | "store_requests"
  | "refund_failed"
  | "courier_incidents"
  | "disputes"
  | "support"
  | "onboarding_stuck"
  | "chat_cap"
  | "ai_spend";

/** One thing waiting for an admin. `ask` is the fixed question the one-tap next step sends to the assistant. */
export interface BriefingItem {
  key: BriefingKey;
  count: number;
  /** The list behind the count was capped, so the real count is at least `count`. */
  incomplete: boolean;
  label: string;
  /** Up to five names (stores), when the item is about named records. */
  names: string[];
  href: string;
  ask: string;
}

export interface AdminBriefing {
  items: BriefingItem[];
  /** Parts that could not be read; the rest still shows. */
  unread: BriefingKey[];
}

export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The briefing's one-line heading. */
export function briefingSummary(items: readonly BriefingItem[]): string {
  if (items.length === 0) return "Nothing is waiting for an admin today.";
  return `${plural(items.length, "thing needs", "things need")} an admin today.`;
}
