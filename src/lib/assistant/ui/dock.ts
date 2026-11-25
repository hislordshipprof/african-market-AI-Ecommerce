/** Pure rules for the admin and store assistant dock (#855). */

export const DOCK_PARAM = "assistant";

/** Enter sends; Shift+Enter is a new line; an IME's Enter finishes the composition. */
export function composerKeySends(event: { key: string; shiftKey: boolean; isComposing: boolean }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

/** The thread follows new messages only while the reader is at (or near) the newest one. */
export function nearLatest(log: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 48): boolean {
  return log.scrollHeight - log.scrollTop - log.clientHeight <= slack;
}

/** `?assistant=open` opens the sheet, so the old /admin/assistant link still lands in the chat. */
export function dockOpenRequested(search: string): boolean {
  return new URLSearchParams(search).get(DOCK_PARAM) === "open";
}

export function withoutDockParam(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete(DOCK_PARAM);
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}

/** How far the floating button rises so it never covers a bar fixed or stuck at the bottom of the screen. */
export function launcherLift(bars: ReadonlyArray<{ top: number; bottom: number }>, viewportHeight: number): number {
  let lift = 0;
  for (const bar of bars) {
    if (bar.top < viewportHeight && bar.bottom > viewportHeight - 24) lift = Math.max(lift, viewportHeight - bar.top);
  }
  return lift;
}
