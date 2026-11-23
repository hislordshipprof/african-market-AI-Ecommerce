/** What /api/directory/near answers (#452). `S` is the card shape the page renders. */
export type NearAnswer<S = unknown> =
  | { kind: "stores"; label: string | null; nearby: boolean; stores: S[] }
  | { kind: "ambiguous"; name: string; states: string[] }
  | { kind: "none" }
  | { kind: "outside" };

export type NearFailure = { text: string; retry: boolean };

export type NearOutcome<S = unknown> = { ok: true; answer: NearAnswer<S> } | ({ ok: false } & NearFailure);

/**
 * The near me search (#728): the last answer stays on screen while a new search runs and when it
 * fails, so a failed search never swaps local results for the nationwide list.
 */
export type NearState<S = unknown> = { answer: NearAnswer<S> | null; pending: boolean; failure: NearFailure | null };

export type NearEvent<S = unknown> =
  | { type: "start" }
  | { type: "done"; answer: NearAnswer<S> }
  | ({ type: "failed" } & NearFailure);

export function nearSearch<S>(state: NearState<S>, event: NearEvent<S>): NearState<S> {
  switch (event.type) {
    case "start":
      return { ...state, pending: true, failure: null };
    case "done":
      return { answer: event.answer, pending: false, failure: null };
    case "failed":
      return { ...state, pending: false, failure: { text: event.text, retry: event.retry } };
  }
}

const TIMEOUT_MS = 10_000;
const DOWN = "Search isn't working right now. Try again in a moment.";
const SLOW = "Search took too long to answer. Try again in a moment.";

/** One near me request, given up after 10 seconds. A refused query keeps the server's message and no retry. */
export async function fetchNear<S>(params: URLSearchParams, fetchFn: typeof fetch = fetch): Promise<NearOutcome<S>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(`/api/directory/near?${params}`, { signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, answer: body as NearAnswer<S> };
    if (res.status >= 500) return { ok: false, text: DOWN, retry: true };
    return { ok: false, text: typeof body.error === "string" ? body.error : DOWN, retry: false };
  } catch {
    return { ok: false, text: controller.signal.aborted ? SLOW : DOWN, retry: true };
  } finally {
    clearTimeout(timer);
  }
}
