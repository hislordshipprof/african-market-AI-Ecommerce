import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState, fakeState } = vi.hoisted(() => ({
  headerState: new Headers(),
  fakeState: { fetch: (async () => new Response("unscripted", { status: 500 })) as typeof fetch },
}));

vi.mock("next/headers", () => ({ headers: async () => headerState }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: () => unknown) => () => fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../../assistant/model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../assistant/model")>();
  return { ...actual, createAssistantModel: () => actual.createAssistantModel({ fetch: fakeState.fetch }) };
});

import { auth } from "../../auth";
import { createFakeAnthropicFetch, type FakeAnthropicStep } from "../../assistant/messages-api-double";
import { setSpendClock } from "../../assistant/spend";
import { authPrisma, platformAdmin, platformAdminTransaction } from "../../db";
import { testSignUp } from "../../test-auth";
import { loadAdminAssistant, sendAdminAssistantMessage } from "./actions";
import { NUMBER_REFUSED } from "./turn";
import { adminAssistantTools, createReadBook } from "./tools";
import { storeScopedTransaction } from "../../db";

const RUN = `t831-${Date.now()}`;
const hasDb = !!process.env.DATABASE_URL;
const password = "Assistant-831-Admin!";
const SPEND_DAY = new Date("2099-11-08T12:00:00.000Z");

type FakeSession = Awaited<ReturnType<typeof auth.api.getSession>>;

function signInAs(user: { id: string; email: string }, role: string | undefined = "platform_admin"): void {
  vi.spyOn(auth.api, "getSession").mockResolvedValue({
    user: { id: user.id, email: user.email, role, twoFactorEnabled: true },
    session: { twoFactorVerified: true },
  } as unknown as FakeSession);
}

function script(steps: FakeAnthropicStep[]) {
  const fake = createFakeAnthropicFetch({ expectedKey: "sk-ant-test", steps });
  fakeState.fetch = fake.fetch;
  return fake;
}

describe.skipIf(!hasDb)("platform admin assistant (#831)", () => {
  const storeId = crypto.randomUUID();
  const storeName = `Stuck ${RUN}`;
  const admin = { id: "", email: `admin-${RUN}@example.com` };
  const other = { id: "", email: `admin2-${RUN}@example.com` };

  beforeAll(async () => {
    setSpendClock(() => SPEND_DAY);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("ASSISTANT_MODEL", "");
    vi.stubEnv("ASSISTANT_SPEND_CAP_USD", "1000000");
    for (const user of [admin, other]) {
      const res = await testSignUp({ email: user.email, password, name: "Admin" });
      expect(res.status, await res.clone().text()).toBe(200);
      user.id = (await authPrisma.user.findFirstOrThrow({ where: { email: user.email } })).id;
    }
    await platformAdminTransaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, doordash_registration_error, updated_at) VALUES (${storeId}, ${storeName}, ${`stuck-${RUN}`}, 'setup', 'Address rejected', now())`;
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await platformAdminTransaction(async (tx) => {
      await tx.auditLog.deleteMany({ where: { actorId: { in: [admin.id, other.id] } } });
      await tx.adminAssistantConversation.deleteMany({ where: { userId: { in: [admin.id, other.id] } } });
      await tx.store.deleteMany({ where: { id: storeId } });
    });
  });

  it("answers 'which stores are stuck in onboarding?' with the store, its gaps and a link, and audits the tool call", async () => {
    signInAs(admin);
    const fake = script([
      { kind: "tool", toolName: "find_stores", toolInput: { status: "setup" } },
      { kind: "text", text: `${storeName} is still in setup. Its courier registration failed.` },
    ]);
    const result = await sendAdminAssistantMessage({ messageId: crypto.randomUUID(), text: "Which stores are stuck in onboarding?" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reply).toContain(storeName);
    expect(result.links).toContainEqual({ label: storeName, href: `/admin/stores/${storeId}` });
    const toolResult = JSON.stringify(fake.requests.at(-1)?.body);
    expect(toolResult).toContain("Address rejected");
    expect(toolResult).toContain("payouts");

    const audit = await platformAdmin.auditLog.findMany({ where: { actorId: admin.id, action: "admin_assistant.tool" } });
    expect(audit).toHaveLength(1);
    expect(audit[0].entityId).toBe(result.conversationId);
    expect(audit[0].after).toMatchObject({ tool: "find_stores", params: { status: "setup" } });
  });

  it("keeps each admin's chats apart, in their own tables", async () => {
    signInAs(admin);
    const mine = await loadAdminAssistant();
    expect(mine.messages.map((m) => m.text)).toContain("Which stores are stuck in onboarding?");
    expect(mine.messages.at(-1)?.links).toContainEqual({ label: storeName, href: `/admin/stores/${storeId}` });

    signInAs(other);
    const theirs = await loadAdminAssistant();
    expect(theirs.messages).toEqual([]);
  });

  it("never passes on a number no tool returned", async () => {
    signInAs(admin);
    script([{ kind: "text", text: "There were 4213 orders yesterday." }]);
    const result = await sendAdminAssistantMessage({ messageId: crypto.randomUUID(), text: "How many orders yesterday?" });
    expect(result.ok && result.reply).toBe(NUMBER_REFUSED);
  });

  it("replays a repeated message id without a second model call", async () => {
    signInAs(admin);
    const messageId = crypto.randomUUID();
    const fake = script([{ kind: "text", text: "I can only read the platform's screens." }]);
    const first = await sendAdminAssistantMessage({ messageId, text: "Hello" });
    const again = await sendAdminAssistantMessage({ messageId, text: "Hello" });
    expect(again).toEqual(first);
    expect(fake.requests).toHaveLength(1);
  });

  it("finds an order by number with a link to its page, and every other read tool answers with a link to its screen", async () => {
    signInAs(admin);
    const orderId = await storeScopedTransaction(storeId, async (tx) => {
      const customer = await tx.customer.create({ data: { storeId, name: "Ada", email: `ada-${RUN}@example.com` } });
      return (await tx.order.create({
        data: { storeId, number: 8311, customerId: customer.id, status: "ACCEPTED", fulfillment: "pickup", subtotalCents: 1250, bufferCents: 0, totalAuthorizedCents: 1250 },
      })).id;
    });
    const book = createReadBook();
    const tools = adminAssistantTools({ actor: admin, conversationId: crypto.randomUUID(), book, now: new Date() });
    const call = (name: keyof typeof tools, input: object) =>
      (tools[name].execute as (input: object, options: object) => Promise<unknown>)(input, { toolCallId: name, messages: [] });

    const found = await call("search_orders", { number: 8311, storeSlug: `stuck-${RUN}` }) as { orders: Array<Record<string, unknown>> };
    expect(found.orders).toEqual([expect.objectContaining({ number: 8311, store: storeName, status: "ACCEPTED", authorizedDollars: 12.5 })]);
    expect(book.links).toContainEqual({ label: `Order 8311, ${storeName}`, href: `/admin/orders/search/${orderId}` });

    const screens: Array<[keyof typeof tools, object, string]> = [
      ["orders_to_check", {}, "/admin/orders/check"],
      ["refund_failed_orders", {}, "/admin/orders"],
      ["courier_incidents", {}, "/admin/couriers/incidents"],
      ["applications_waiting", {}, "/admin/applications"],
      ["support_and_disputes", {}, "/admin/disputes"],
      ["ai_spend_and_flags", {}, "/admin/ai/eval-spend"],
      ["catalogue_queues", {}, "/admin/catalog/review"],
      ["platform_totals", { from: "1999-01-01", to: "1999-01-02" }, "/admin/orders/search"],
      ["store_detail", { slug: `stuck-${RUN}` }, `/admin/stores/${storeId}`],
    ];
    for (const [name, input, href] of screens) {
      await call(name, input);
      expect(book.links.map((item) => item.href), name).toContain(href);
    }
    const audited = await platformAdmin.auditLog.count({ where: { actorId: admin.id, action: "admin_assistant.tool" } });
    expect(audited).toBe(1 + 1 + screens.length);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.deleteMany({ where: { storeId } });
      await tx.customer.deleteMany({ where: { storeId } });
    });
  });

  it("gives each courier's registration error, Uber's as well as DoorDash's", async () => {
    await platformAdminTransaction((tx) => tx.store.update({ where: { id: storeId }, data: { uberRegistrationError: "Uber address rejected" } }));
    const tools = adminAssistantTools({ actor: admin, conversationId: crypto.randomUUID(), book: createReadBook(), now: new Date() });
    const call = (name: keyof typeof tools, input: object) =>
      (tools[name].execute as (input: object, options: object) => Promise<unknown>)(input, { toolCallId: name, messages: [] });
    const errors = { doordash: "Address rejected", uber: "Uber address rejected" };

    const found = await call("find_stores", { query: `stuck-${RUN}` }) as { stores: Array<Record<string, unknown>> };
    expect(found.stores[0]).toMatchObject({ courierRegistrationErrors: errors });
    expect(await call("store_detail", { slug: `stuck-${RUN}` })).toMatchObject({ courierRegistrationErrors: errors });
  });

  it("refuses anyone who is not a platform admin", async () => {
    signInAs(admin, "customer");
    script([{ kind: "text", text: "hi" }]);
    await expect(sendAdminAssistantMessage({ messageId: crypto.randomUUID(), text: "Hello" })).rejects.toThrow("NEXT_REDIRECT");
  });
});
