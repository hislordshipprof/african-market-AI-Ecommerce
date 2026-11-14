import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

type Listener = (event: Record<string, unknown>) => void;

/** Runs public/push-sw.js against a recording CacheStorage. */
function loadWorker(network: (request: Request) => Promise<Response>) {
  const listeners = new Map<string, Listener>();
  const added: string[] = [];
  const put = vi.fn();
  const offline = new Response("offline");
  const cache = { addAll: async (urls: string[]) => void added.push(...urls), put, add: put };
  const caches = {
    open: async () => cache,
    keys: async () => ["offline-v0", "offline-v1"],
    delete: vi.fn(async () => true),
    match: async (url: string) => (added.includes(url) ? offline : undefined),
  };
  const self = {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
    registration: { showNotification: vi.fn() },
    location: { origin: "https://shop.example" },
  };
  const source = readFileSync(path.join(process.cwd(), "public/push-sw.js"), "utf8");
  new Function("self", "caches", "fetch", source)(self, caches, network);
  return { listeners, added, put, caches, offline };
}

async function dispatch(listeners: Map<string, Listener>, type: string, event: Record<string, unknown>) {
  const waits: Promise<unknown>[] = [];
  let response: Promise<Response> | undefined;
  listeners.get(type)?.({
    ...event,
    waitUntil: (p: Promise<unknown>) => waits.push(p),
    respondWith: (p: Promise<Response>) => {
      response = p;
    },
  });
  await Promise.all(waits);
  return response;
}

describe("service worker (#563)", () => {
  it("caches the offline page and nothing else: never a price, cart or money page", async () => {
    const worker = loadWorker(async () => new Response("live"));
    await dispatch(worker.listeners, "install", {});
    expect(worker.added).toEqual(["/offline.html"]);

    for (const url of ["/", "/cart", "/checkout", "/order/tok", "/listings/egusi", "/api/cart"]) {
      const response = await dispatch(worker.listeners, "fetch", {
        request: { url: `https://shop.example${url}`, method: "GET", mode: "navigate" },
      });
      if (response) await response;
    }
    expect(worker.put).not.toHaveBeenCalled();
  });

  it("a page navigation that fails offline gets the offline page; other requests are left to the network", async () => {
    const worker = loadWorker(async () => {
      throw new TypeError("offline");
    });
    await dispatch(worker.listeners, "install", {});
    const navigation = { url: "https://shop.example/cart", method: "GET", mode: "navigate" };
    expect(await dispatch(worker.listeners, "fetch", { request: navigation })).toBeDefined();
    expect(await (await dispatch(worker.listeners, "fetch", { request: navigation }))!.text()).toBe("offline");

    const api = { url: "https://shop.example/api/cart", method: "GET", mode: "cors" };
    expect(await dispatch(worker.listeners, "fetch", { request: api })).toBeUndefined();
    const post = { url: "https://shop.example/checkout", method: "POST", mode: "navigate" };
    expect(await dispatch(worker.listeners, "fetch", { request: post })).toBeUndefined();
  });

  it("activation drops older offline caches", async () => {
    const worker = loadWorker(async () => new Response("live"));
    await dispatch(worker.listeners, "activate", {});
    expect(worker.caches.delete).toHaveBeenCalledWith("offline-v0");
    expect(worker.caches.delete).not.toHaveBeenCalledWith("offline-v1");
  });
});
