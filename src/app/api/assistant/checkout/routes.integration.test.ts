import { vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: () => undefined,
}));

import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "./card/route";
import { storeScoped } from "@/lib/db";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("assistant checkout card route", () => {
  let raw: PrismaClient;
  let storeId = "";
  let slug = "";
  let cartId = "";
  let attemptId = "";

  beforeAll(async () => {
    process.env.ASSISTANT_CHAT_ENABLED = "1";
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const suffix = randomUUID().slice(0, 8);
    slug = `card-${suffix}`;
    const store = await raw.store.create({
      data: { slug, name: "Card Store", themePreset: "palm-and-shea", status: "active" },
    });
    storeId = store.id;
    cartId = (await storeScoped(storeId).cart.create({ data: { storeId, source: "manual" } })).id;
    const conversation = await storeScoped(storeId).aiConversation.create({
      data: { storeId, cartId, model: "claude-haiku-5-5", messages: [] },
    });
    attemptId = (await storeScoped(storeId).assistantCheckoutAttempt.create({
      data: {
        storeId,
        cartId,
        conversationId: conversation.id,
        status: "open",
        snapshotHash: "hash",
        snapshot: { holdCents: 800, lines: [] },
        paymentKind: "new",
        idempotencyKey: `assistant-pi:${randomUUID()}`,
        reservedAmountCents: 800,
        windowMinutes: 10,
        contactVersion: 1,
        expiresAt: new Date(Date.now() + 60_000),
      },
    })).id;
  });

  afterAll(async () => {
    if (!storeId) return;
    await storeScoped(storeId).assistantCheckoutToken.deleteMany({});
    await storeScoped(storeId).assistantCheckoutAttempt.deleteMany({});
    await storeScoped(storeId).aiConversation.deleteMany({});
    await storeScoped(storeId).cart.deleteMany({});
    await raw.store.delete({ where: { id: storeId } });
    await raw.$disconnect();
  });

  function request(init: { origin?: string | null; slug?: string; cookie?: string; body?: BodyInit; attempt?: string }) {
    const headers = new Headers({ host: "localhost", "content-type": "application/json" });
    if (init.origin !== null) headers.set("origin", init.origin ?? "http://localhost");
    if (init.slug !== undefined) headers.set("x-store-slug", init.slug);
    else headers.set("x-store-slug", slug);
    if (init.cookie) headers.set("cookie", init.cookie);
    return new Request("http://localhost/api/assistant/checkout/card", {
      method: "POST",
      headers,
      body: init.body ?? JSON.stringify({ attemptId: init.attempt ?? attemptId }),
      duplex: "half",
    } as RequestInit);
  }

  it("accepts a same-origin post for this cart", async () => {
    const response = await POST(request({ cookie: `cart_id=${encodeURIComponent(cartId)}` }));
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; token?: string };
    expect(body.ok).toBe(true);
    expect(body.token).toBeTruthy();
  });

  it("refuses a post with no Origin", async () => {
    const response = await POST(request({ origin: null, cookie: `cart_id=${encodeURIComponent(cartId)}` }));
    expect(response.status).toBe(403);
  });

  it("returns not found for another store and for another person's cart", async () => {
    const foreignStore = await POST(request({ slug: "missing-store", cookie: `cart_id=${encodeURIComponent(cartId)}` }));
    expect(foreignStore.status).toBe(404);
    const other = await raw.store.create({
      data: { slug: `other-${randomUUID().slice(0, 8)}`, name: "Other", themePreset: "palm-and-shea", status: "active" },
    });
    const owned = await storeScoped(other.id).cart.create({ data: { storeId: other.id, source: "manual" } });
    const foreignActor = await POST(request({ cookie: `cart_id=${encodeURIComponent(owned.id)}`, attempt: attemptId }));
    expect(foreignActor.status).toBe(404);
    await storeScoped(other.id).cart.deleteMany({});
    await raw.store.delete({ where: { id: other.id } });
  });

  it("stops reading once the body passes the cap", async () => {
    let reads = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(4096));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await POST(request({ body: stream, cookie: `cart_id=${encodeURIComponent(cartId)}` }));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThan(5);
  });
});
