import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNear, nearSearch, type NearAnswer, type NearState } from "./near-search";

const houston: NearAnswer = { kind: "stores", label: "77002", nearby: true, stores: [] };
const newYork: NearAnswer = { kind: "stores", label: "New York, NY", nearby: false, stores: [] };
const idle: NearState = { answer: null, pending: false, failure: null };

function respond(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

/** A fetch that never answers, and rejects the way the browser does when its signal aborts. */
const hanging = vi.fn(
  (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
);

afterEach(() => {
  vi.useRealTimers();
});

describe("near me search states (#728 AC1)", () => {
  it("keeps the previous results while a new search runs", () => {
    const shown = nearSearch(idle, { type: "done", answer: houston });
    const refreshing = nearSearch(shown, { type: "start" });
    expect(refreshing).toEqual({ answer: houston, pending: true, failure: null });
  });

  it("keeps the previous results when the new search fails", () => {
    const shown = nearSearch(idle, { type: "done", answer: houston });
    const failed = nearSearch(nearSearch(shown, { type: "start" }), { type: "failed", text: "Search took too long.", retry: true });
    expect(failed).toEqual({ answer: houston, pending: false, failure: { text: "Search took too long.", retry: true } });
  });

  it("replaces the results and clears the failure when a search succeeds", () => {
    const failed = nearSearch(nearSearch(idle, { type: "done", answer: houston }), { type: "failed", text: "x", retry: true });
    expect(nearSearch(failed, { type: "done", answer: newYork })).toEqual({ answer: newYork, pending: false, failure: null });
  });
});

describe("fetchNear (#728 AC1)", () => {
  it("returns the server's answer", async () => {
    const fetchFn = respond(200, houston);
    await expect(fetchNear(new URLSearchParams({ q: "77002" }), fetchFn)).resolves.toEqual({ ok: true, answer: houston });
    expect(String(fetchFn.mock.calls[0][0])).toBe("/api/directory/near?q=77002");
  });

  it("passes on a refused query's message, with no retry", async () => {
    const outcome = await fetchNear(new URLSearchParams({ q: "" }), respond(400, { error: "Enter a ZIP code or city." }));
    expect(outcome).toEqual({ ok: false, text: "Enter a ZIP code or city.", retry: false });
  });

  it("offers a retry when the server fails or the network drops", async () => {
    expect(await fetchNear(new URLSearchParams({ q: "77002" }), respond(503, {}))).toMatchObject({ ok: false, retry: true });
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchNear(new URLSearchParams({ q: "77002" }), offline)).toMatchObject({ ok: false, retry: true });
  });

  it("gives up after 10 seconds and offers a retry", async () => {
    vi.useFakeTimers();
    let settled: unknown = null;
    void fetchNear(new URLSearchParams({ q: "77002" }), hanging).then((outcome) => (settled = outcome));
    await vi.advanceTimersByTimeAsync(9_900);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toMatchObject({ ok: false, retry: true, text: expect.stringMatching(/too long/) });
  });
});
