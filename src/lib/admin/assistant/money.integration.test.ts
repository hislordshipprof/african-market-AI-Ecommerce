import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

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
vi.mock("../../inngest/notify", async (original) => ({
  ...(await original<typeof import("../../inngest/notify")>()),
  scheduleOrderNotification: vi.fn(),
}));

import { auth } from "../../auth";
import { authPrisma, platformAdmin, platformAdminTransaction, storeScoped } from "../../db";
import { setStripeProvider } from "../../stripe";
import { fakeStripeProvider, refundRequests, reset, setAuthorizedAmount } from "../../stripe/fake";
import { countedListing } from "../../order/stock-ledger-test-helpers";
import { testSignUp } from "../../test-auth";
import { testPrismaClient } from "../../test-prisma";
import { confirmAdminAssistantDraft } from "./actions";
import { insertAdminDrafts, type AdminDraftCard } from "./drafts";
import { adminAssistantTools, createReadBook } from "./tools";

const RUN = `t834-${Date.now()}`;
const hasDb = !!process.env.DATABASE_URL;

type FakeSession = Awaited<ReturnType<typeof auth.api.getSession>>;
const sql = <T>(fn: Parameters<typeof platformAdminTransaction<T>>[0]) => platformAdminTransaction(fn);

describe.skipIf(!hasDb)("platform admin assistant money and hard-to-undo cards (#834)", () => {
  const admin = { id: "", email: `admin-${RUN}@example.com` };
  const storeId = crypto.randomUUID();
  const setupId = crypto.randomUUID();
  const slug = `money-${RUN}`;
  const setupSlug = `golive-${RUN}`;
  const ids = { refundable: "", failed: "", category: "", recipe: "" };
  const categoryName = `Empty shelf ${RUN}`;
  const recipeName = `Drafted stew ${RUN}`;
  let conversationId = "";
  const owner = testPrismaClient();

  async function draft(name: string, input: Record<string, unknown>): Promise<{ result: Record<string, unknown>; cards: AdminDraftCard[] }> {
    const book = createReadBook();
    const tools = adminAssistantTools({ actor: admin, conversationId, book, now: new Date() }) as unknown as Record<string, { execute?: (input: unknown, opts: unknown) => Promise<unknown> }>;
    const result = (await tools[name]!.execute!(input, { toolCallId: "t", messages: [] })) as Record<string, unknown>;
    const cards = await sql((tx) => insertAdminDrafts(tx, { userId: admin.id, email: admin.email, conversationId, messageId: crypto.randomUUID() }, book.drafts));
    return { result, cards };
  }

  const confirmedAudit = (draftId: string) => platformAdmin.auditLog.findFirst({ where: { entityId: draftId, action: "admin_assistant.draft_confirmed" } });

  beforeAll(async () => {
    const res = await testSignUp({ email: admin.email, password: "Assistant-834-Admin!", name: "Admin" });
    expect(res.status).toBe(200);
    admin.id = (await authPrisma.user.findFirstOrThrow({ where: { email: admin.email } })).id;
    vi.spyOn(auth.api, "getSession").mockResolvedValue({
      user: { id: admin.id, email: admin.email, role: "platform_admin", twoFactorEnabled: true },
      session: { twoFactorVerified: true },
    } as unknown as FakeSession);
    reset();
    setStripeProvider(fakeStripeProvider);
    conversationId = crypto.randomUUID();
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.adminAssistantConversation.create({ data: { id: conversationId, userId: admin.id, model: "test" } });
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, address_line1, zip, updated_at) VALUES (${storeId}, ${`Money Market ${RUN}`}, ${slug}, 'active', '1 Money Way', '20782', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, address_line1, zip, updated_at) VALUES (${setupId}, ${`Go Live Market ${RUN}`}, ${setupSlug}, 'setup', '2 Money Way', '20782', now())`;
      ids.category = (await tx.category.create({ data: { name: categoryName, slug: `empty-${RUN}`, sortOrder: 999 } })).id;
      ids.recipe = (await tx.recipe.create({ data: { key: `stew-${RUN}`, name: recipeName, aliases: [], origin: "drafted", ingredients: { create: [{ position: 0, name: "rice" }] } } })).id;
    });
    const variantId = (await countedListing(storeId, 50)).variantId;
    const customer = await storeScoped(storeId).customer.create({ data: { storeId, name: "Ada Obi", email: `ada@${RUN}.test` } });
    const order = async (number: number, status: "COMPLETED" | "REFUND_FAILED") => {
      const pi = `pi_${RUN}_${number}`;
      setAuthorizedAmount(pi, 2000);
      await fakeStripeProvider.capturePaymentIntent(pi, 2000, `cap-${RUN}-${number}`);
      const row = await storeScoped(storeId).order.create({
        data: { storeId, number, customerId: customer.id, status, fulfillment: "pickup", subtotalCents: 2000, bufferCents: 0, totalAuthorizedCents: 2000, totalCents: 2000, capturedAmountCents: 2000, paymentIntentId: pi, completedAt: new Date() },
      });
      await storeScoped(storeId).orderLine.create({ data: { storeId, orderId: row.id, listingVariantId: variantId, qtyOrdered: 1, qtyPicked: 1, unitPriceCents: 2000, status: "picked" } });
      return row.id;
    };
    ids.refundable = await order(8341, "COMPLETED");
    ids.failed = await order(8342, "REFUND_FAILED");
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    setStripeProvider(null);
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.adminAssistantConversation.deleteMany({ where: { userId: admin.id } });
      await tx.category.deleteMany({ where: { id: ids.category } });
      await tx.recipe.deleteMany({ where: { id: ids.recipe } });
    });
    // Each table in its own transaction, so one the store never wrote to cannot abort the rest.
    for (const id of [storeId, setupId]) {
      for (const table of ["refund_requests", "notification_logs", "order_lines", "stock_events", "orders", "customers", "listings", "audit_logs", "store_subscriptions", "stores"]) {
        await owner.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
          await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE ${table === "stores" ? "id" : "store_id"} = $1`, id);
        }).catch((error) => console.warn(`cleanup ${table}`, (error as Error).message.slice(-120)));
      }
    }
    await owner.$disconnect();
  });

  it("shows the refund amount, refuses a confirm with no typed reason, and refunds with the admin's reason in AuditLog", async () => {
    const { result, cards } = await draft("draft_platform_refund", { orderNumber: 8341, storeSlug: slug, amountDollars: 5 });
    expect(result).toMatchObject({ drafted: true });
    const card = cards[0]!;
    expect(card.editable).toMatchObject({ text: "" });
    expect(card.changes.map((change) => change.to).join(" ")).toContain("$5.00");

    expect(await confirmAdminAssistantDraft({ draftId: card.id })).toMatchObject({ ok: false, code: "invalid" });
    expect(await confirmAdminAssistantDraft({ draftId: card.id, text: "   " })).toMatchObject({ ok: false, code: "invalid" });
    expect(refundRequests.filter((r) => r.paymentIntentId === `pi_${RUN}_8341`)).toHaveLength(0);

    const reason = "Customer got the wrong yams";
    expect(await confirmAdminAssistantDraft({ draftId: card.id, text: reason })).toMatchObject({ ok: true, draft: { state: "confirmed" } });
    expect(refundRequests.filter((r) => r.paymentIntentId === `pi_${RUN}_8341`).map((r) => r.amountCents)).toEqual([500]);
    expect((await confirmedAudit(card.id))?.after).toMatchObject({ kind: "platform_refund", params: { reason } });
  });

  it("resolves a refund-failed order with the typed reason as the note", async () => {
    const { cards } = await draft("draft_refund_resolve", { orderNumber: 8342, storeSlug: slug });
    const card = cards[0]!;
    expect(card.changes.map((change) => change.to).join(" ")).toContain("$20.00");
    expect(card.editable).toMatchObject({ text: "" });
    expect(await confirmAdminAssistantDraft({ draftId: card.id })).toMatchObject({ ok: false, code: "invalid" });

    const reason = "Repaid by Zelle on the phone";
    expect(await confirmAdminAssistantDraft({ draftId: card.id, text: reason })).toMatchObject({ ok: true });
    const order = await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: ids.failed } });
    expect(order.status).toBe("CANCELLED");
    expect(order.notes).toContain(reason);
    expect((await confirmedAudit(card.id))?.after).toMatchObject({ params: { note: reason } });
  });

  it("forces go-live listing the open checklist items, and needs a reason first", async () => {
    const { cards } = await draft("draft_force_go_live", { slug: setupSlug });
    const card = cards[0]!;
    expect(card.changes.length).toBeGreaterThan(1);
    expect(await confirmAdminAssistantDraft({ draftId: card.id })).toMatchObject({ ok: false, code: "invalid" });
    expect((await platformAdmin.store.findUniqueOrThrow({ where: { id: setupId } })).status).toBe("setup");

    const reason = "Owner is a pilot; menu goes up tonight";
    expect(await confirmAdminAssistantDraft({ draftId: card.id, text: reason })).toMatchObject({ ok: true });
    expect((await platformAdmin.store.findUniqueOrThrow({ where: { id: setupId } })).status).toBe("active");
    const forced = await platformAdmin.auditLog.findFirst({ where: { entityId: setupId, action: "store.go_live_forced" } });
    expect(forced?.after).toMatchObject({ reason });
  });

  it("deletes an empty category and a drafted recipe, each saying what will be removed and keeping the reason", async () => {
    const category = (await draft("draft_category_removal", { name: categoryName })).cards[0]!;
    expect(category.changes.map((change) => change.from).join(" ")).toContain(categoryName);
    expect(await confirmAdminAssistantDraft({ draftId: category.id })).toMatchObject({ ok: false, code: "invalid" });
    expect(await confirmAdminAssistantDraft({ draftId: category.id, text: "Never used" })).toMatchObject({ ok: true });
    expect(await sql((tx) => tx.category.findUnique({ where: { id: ids.category } }))).toBeNull();
    expect((await confirmedAudit(category.id))?.after).toMatchObject({ params: { reason: "Never used" } });

    const recipe = (await draft("draft_recipe_removal", { name: recipeName })).cards[0]!;
    expect(recipe.changes.map((change) => change.from).join(" ")).toContain(recipeName);
    expect(await confirmAdminAssistantDraft({ draftId: recipe.id, text: "Duplicate of jollof" })).toMatchObject({ ok: true });
    expect(await sql((tx) => tx.recipe.findUnique({ where: { id: ids.recipe } }))).toBeNull();
    expect((await confirmedAudit(recipe.id))?.after).toMatchObject({ params: { reason: "Duplicate of jollof" } });
  });

  it("drafts one order per refund card: the tool takes a single order, never a list", async () => {
    const { result, cards } = await draft("draft_platform_refund", { orderNumber: 8341, storeSlug: slug, amountDollars: 1, orders: [8342] });
    expect(result).toMatchObject({ drafted: true });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.items).toBeUndefined();
    expect(cards[0]!.steps).toBeUndefined();
  });
});
