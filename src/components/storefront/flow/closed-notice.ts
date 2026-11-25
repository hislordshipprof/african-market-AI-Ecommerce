export type ClosedNotice = { kind: "queue" } | { kind: "slot"; label: string };

/** What checkout says while the store is closed (#811): a chosen time is named; only an as-soon-as-open order joins the queue. */
export function closedNotice(input: {
  closed: boolean;
  shipping: boolean;
  scheduled: boolean;
  slot: string;
  slots: Array<{ value: string; label: string }>;
}): ClosedNotice | null {
  if (!input.closed || input.shipping) return null;
  if (!input.scheduled) return { kind: "queue" };
  const chosen = input.slots.find((option) => option.value === input.slot);
  return chosen ? { kind: "slot", label: chosen.label } : null;
}
