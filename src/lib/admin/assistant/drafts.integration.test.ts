import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

import { auth } from "../../auth";
import { fakeAddressBackend, setAddressProvider } from "../../address/provider";
import { authPrisma, platformAdmin, platformAdminTransaction } from "../../db";
import { readCourierSettings, type CourierSettings } from "../../delivery/courier-settings";
import { testSignUp } from "../../test-auth";
import { testPrismaClient } from "../../test-prisma";
import { confirmAdminAssistantDraft, rejectAdminAssistantDraft } from "./actions";
import { insertAdminDrafts, type AdminDraftCard } from "./drafts";
import { adminAssistantTools, createReadBook } from "./tools";

const RUN = `t832-${Date.now()}`;
const hasDb = !!process.env.DATABASE_URL;
const password = "Assistant-832-Admin!";

type FakeSession = Awaited<ReturnType<typeof auth.api.getSession>>;

function signInAs(user: { id: string; email: string }, twoFactor = true): void {
  vi.spyOn(auth.api, "getSession").mockResolvedValue({
    user: { id: user.id, email: user.email, role: "platform_admin", twoFactorEnabled: twoFactor },
    session: { twoFactorVerified: twoFactor },
  } as unknown as FakeSession);
}

const sql = <T>(fn: Parameters<typeof platformAdminTransaction<T>>[0]) => platformAdminTransaction(fn);
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!hasDb)("platform admin assistant drafts at the confirm seam (#832)", () => {
  const admin = { id: "", email: `admin-${RUN}@example.com` };
  const other = { id: "", email: `admin2-${RUN}@example.com` };
  const bob = { id: "", email: `bob-${RUN}@example.com` };
  const storeId = crypto.randomUUID();
  const slug = `drafts-${RUN}`;
  const storeName = `Drafts Market ${RUN}`;
  const metroId = crypto.randomUUID();
  const metroName = `Metro ${RUN}`;
  const ids = { order: "", thread: "", copilotChat: "", application: "", application2: "" };
  let conversationId = "";
  let courierBefore: CourierSettings | null = null;
  // Fixtures and cleanup run as the owner role: notes are append-only for app_user.
  const owner = testPrismaClient();

  async function draft(name: string, input: Record<string, unknown>): Promise<{ result: Record<string, unknown>; cards: AdminDraftCard[] }> {
    const book = createReadBook();
    const tools = adminAssistantTools({ actor: admin, conversationId, book, now: new Date() }) as unknown as Record<string, { execute?: (input: unknown, opts: unknown) => Promise<unknown> }>;
    const result = (await tools[name]!.execute!(input, { toolCallId: "t", messages: [] })) as Record<string, unknown>;
    const messageId = crypto.randomUUID();
    const cards = await sql((tx) => insertAdminDrafts(tx, { userId: admin.id, email: admin.email, conversationId, messageId }, book.drafts));
    return { result, cards };
  }

  const auditFor = (entityId: string) => platformAdmin.auditLog.findMany({ where: { entityId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const draftRow = (id: string) => sql((tx) => tx.adminAssistantDraft.findUniqueOrThrow({ where: { id } }));
  const store = () => platformAdmin.store.findUniqueOrThrow({ where: { id: storeId } });

  beforeAll(async () => {
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "");
    setAddressProvider(fakeAddressBackend());
    for (const user of [admin, other, bob]) {
      const res = await testSignUp({ email: user.email, password, name: "Admin" });
      expect(res.status, await res.clone().text()).toBe(200);
      user.id = (await authPrisma.user.findFirstOrThrow({ where: { email: user.email } })).id;
    }
    conversationId = crypto.randomUUID();
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.adminAssistantConversation.create({ data: { id: conversationId, userId: admin.id, model: "test" } });
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, address_line1, zip, updated_at) VALUES (${storeId}, ${storeName}, ${slug}, 'active', '1 Drafts Way', '20782', now())`;
      await tx.storeSubscription.create({ data: { storeId } });
      await tx.metro.create({ data: { id: metroId, name: metroName, states: ["MD"], centerLat: 38.9, centerLng: -76.9, radiusMi: 30 } });
      const customer = await tx.customer.create({ data: { storeId, name: "Ada Obi", phone: "+13015550199" } });
      const order = await tx.order.create({
        data: { storeId, customerId: customer.id, number: 832, status: "COURIER_REQUESTED", fulfillment: "courier", subtotalCents: 4000, bufferCents: 0, totalCents: 4000, totalAuthorizedCents: 4000 },
      });
      ids.order = order.id;
      await tx.deliveryEvent.create({ data: { storeId, orderId: order.id, type: "both_failed", payload: { options: ["cancel"] } } });
      const thread = await tx.supportThread.create({
        data: { storeId, orderId: order.id, topic: "order", state: "escalated", escalatedAt: new Date(), lastCustomerAt: new Date(Date.now() - 60_000) },
      });
      ids.thread = thread.id;
      const chat = await tx.copilotConversation.create({ data: { storeId, userId: admin.id, model: "test" } });
      ids.copilotChat = chat.id;
      const application = (name: string, email: string, phone: string) => tx.storeApplication.create({
        data: { businessName: name, storeType: "african", addressLine1: "9 Apply St", city: "Laurel", state: "MD", zip: "20707", ownerName: "Ada", email, phone, offersPickup: true },
      });
      const digits = String(Date.now()).slice(-6);
      ids.application = (await application(`Apply ${RUN}`, `apply-${RUN}@example.com`, `+1301${digits}1`)).id;
      ids.application2 = (await application(`Reject ${RUN}`, `reject-${RUN}@example.com`, `+1301${digits}2`)).id;
    });
    courierBefore = await readCourierSettings();
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    if (courierBefore) {
      const seconds = courierBefore.assignmentTimeoutSeconds;
      await sql((tx) => tx.$executeRaw`UPDATE platform_settings SET courier_assignment_timeout_s = ${seconds} WHERE id = 'platform'`);
    }
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    setAddressProvider(null);
    const approved = await platformAdmin.storeApplication.findUnique({ where: { id: ids.application }, select: { storeId: true } });
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.adminAssistantConversation.deleteMany({ where: { userId: { in: [admin.id, other.id] } } });
      await tx.storeApplication.deleteMany({ where: { id: { in: [ids.application, ids.application2] } } });
      for (const id of [storeId, approved?.storeId].filter((value): value is string => !!value)) {
        await tx.$executeRaw`DELETE FROM ai_review_flags WHERE store_id = ${id}`;
        await tx.$executeRaw`DELETE FROM copilot_conversations WHERE store_id = ${id}`;
        await tx.$executeRaw`DELETE FROM courier_incident_notes WHERE store_id = ${id}`;
        await tx.$executeRaw`DELETE FROM support_messages WHERE store_id = ${id}`;
        await tx.$executeRaw`DELETE FROM support_threads WHERE store_id = ${id}`;
        await tx.$executeRaw`DELETE FROM delivery_events WHERE store_id = ${id}`;
        await tx.$executeRaw`DELETE FROM orders WHERE store_id = ${id}`;
        await tx.$executeRaw`DELETE FROM customers WHERE store_id = ${id}`;
        await tx.$executeRaw`DELETE FROM store_invites WHERE store_id = ${id}`;
        await tx.$executeRaw`DELETE FROM store_subscriptions WHERE store_id = ${id}`;
        await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id = ${id}`;
        await tx.$executeRaw`DELETE FROM stores WHERE id = ${id}`;
      }
      await tx.metro.deleteMany({ where: { id: metroId } });
    });
    await owner.$disconnect();
  });

  it("suspends a store on confirm through the admin's own status change, with the card showing from and to", async () => {
    signInAs(admin);
    const { cards } = await draft("draft_store_status", { slug, status: "suspended" });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ state: "pending", storeName, title: "Suspend store", changes: [{ field: "Status", from: "active", to: "suspended" }] });
    expect((await store()).status).toBe("active");

    const confirmed = await confirmAdminAssistantDraft({ draftId: cards[0]!.id });
    expect(confirmed).toMatchObject({ ok: true, draft: { state: "confirmed" } });
    expect((await store()).status).toBe("suspended");
    const actions = (await auditFor(cards[0]!.id)).map((row) => row.action);
    expect(actions).toEqual(["admin_assistant.draft_proposed", "admin_assistant.draft_confirmed"]);
    expect(await platformAdmin.auditLog.count({ where: { entityId: storeId, action: "store.suspend", actorId: admin.id } })).toBe(1);

    const reactivate = await draft("draft_store_status", { slug, status: "active" });
    expect(await confirmAdminAssistantDraft({ draftId: reactivate.cards[0]!.id })).toMatchObject({ ok: true });
    expect((await store()).status).toBe("active");
  });

  it("goes stale instead of applying when the store changed since the draft", async () => {
    signInAs(admin);
    const { cards } = await draft("draft_store_status", { slug, status: "suspended" });
    await sql((tx) => tx.store.update({ where: { id: storeId }, data: { status: "suspended" } }));
    await sql((tx) => tx.store.update({ where: { id: storeId }, data: { status: "setup" } }));

    const result = await confirmAdminAssistantDraft({ draftId: cards[0]!.id });
    expect(result).toMatchObject({ ok: false, code: "stale" });
    expect((await store()).status).toBe("setup");
    expect((await draftRow(cards[0]!.id)).state).toBe("stale");
    expect((await auditFor(cards[0]!.id)).map((row) => row.action)).toEqual(["admin_assistant.draft_proposed", "admin_assistant.draft_stale"]);
    await sql((tx) => tx.store.update({ where: { id: storeId }, data: { status: "active" } }));
  });

  it("expires a draft after 24 hours and applies nothing", async () => {
    signInAs(admin);
    const { cards } = await draft("draft_store_status", { slug, status: "suspended" });
    expect(new Date(cards[0]!.expiresAt).getTime() - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    await sql((tx) => tx.adminAssistantDraft.update({ where: { id: cards[0]!.id }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id })).toMatchObject({ ok: false, code: "expired" });
    expect((await store()).status).toBe("active");
  });

  it("logs a reject, and a rejected draft cannot then be confirmed", async () => {
    signInAs(admin);
    const { cards } = await draft("draft_store_status", { slug, status: "suspended" });
    expect(await rejectAdminAssistantDraft({ draftId: cards[0]!.id })).toMatchObject({ ok: true, draft: { state: "rejected" } });
    expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id })).toMatchObject({ ok: false, code: "not_found" });
    expect((await store()).status).toBe("active");
    const rejected = (await auditFor(cards[0]!.id)).find((row) => row.action === "admin_assistant.draft_rejected");
    expect(rejected).toMatchObject({ actorId: admin.id, actorEmail: admin.email, storeId });
  });

  it("refuses the confirm for an admin without 2FA, and another admin's draft is not theirs", async () => {
    signInAs(admin);
    const { cards } = await draft("draft_store_status", { slug, status: "suspended" });
    signInAs(admin, false);
    await expect(confirmAdminAssistantDraft({ draftId: cards[0]!.id })).rejects.toThrow("NEXT_REDIRECT:/admin/enroll-2fa");
    signInAs(other);
    expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id })).toMatchObject({ ok: false, code: "not_found" });
    expect((await draftRow(cards[0]!.id)).state).toBe("pending");
    expect((await store()).status).toBe("active");
    expect((await auditFor(cards[0]!.id)).map((row) => row.action)).toEqual(["admin_assistant.draft_proposed"]);
  });

  it("has no tool for a never-allowed change, and refuses a forged draft to make bob a platform admin", async () => {
    const names = Object.keys(adminAssistantTools({ actor: admin, conversationId, book: createReadBook(), now: new Date() }));
    expect(names.filter((name) => /admin_role|platform_admin|role|2fa|two_factor|security|stripe|payout|secret|delete|remove_user/.test(name))).toEqual([]);

    signInAs(admin);
    const forged = await sql((tx) => tx.adminAssistantDraft.create({
      data: {
        userId: admin.id, conversationId, clientMessageId: "forged", kind: "set_user_role", storeId: null,
        payload: { params: { userId: bob.id, role: "platform_admin" }, view: { title: "Make bob a platform admin", storeName: null, changes: [], editable: null, warning: null, href: null } },
        before: {}, state: "pending", expiresAt: new Date(Date.now() + 3_600_000),
      },
    }));
    expect(await confirmAdminAssistantDraft({ draftId: forged.id })).toMatchObject({ ok: false, code: "refused" });
    expect((await authPrisma.user.findUniqueOrThrow({ where: { id: bob.id } })).role).not.toBe("platform_admin");
    expect((await draftRow(forged.id)).state).toBe("rejected");
    expect((await auditFor(forged.id)).map((row) => row.action)).toEqual(["admin_assistant.draft_refused"]);
  });

  it("sets a plan override with an end date and the admin's edited reason", async () => {
    signInAs(admin);
    const endsOn = inDays(30);
    const { cards } = await draft("draft_plan_override", { slug, plan: "pro", endsOn, reason: "Launch help" });
    expect(cards[0]).toMatchObject({ storeName, editable: { text: "Launch help" } });
    expect(cards[0]!.changes).toContainEqual({ field: "Override ends", from: "No override", to: endsOn });
    expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id, text: "Launch help for the grand opening" })).toMatchObject({ ok: true });
    const subscription = await platformAdmin.storeSubscription.findUniqueOrThrow({ where: { storeId } });
    expect(subscription).toMatchObject({ overridePlan: "pro", overrideReason: "Launch help for the grand opening" });
    expect(subscription.overrideEndsAt?.toISOString().slice(0, 10)).toBe(endsOn);
  });

  it("grants the pilot offer", async () => {
    signInAs(admin);
    const { cards } = await draft("draft_pilot", { slug, pilot: true });
    expect(cards[0]!.changes).toEqual([{ field: "Pilot offer", from: "Off", to: "On" }]);
    const result = await confirmAdminAssistantDraft({ draftId: cards[0]!.id });
    const pilot = (await platformAdmin.storeSubscription.findUniqueOrThrow({ where: { storeId } })).pilot;
    // The pilot offer has a store cap; when other stores fill it, the admin's own function refuses and the draft stays pending.
    if (result.ok) expect(pilot).toBe(true);
    else expect(result).toMatchObject({ code: "invalid", message: expect.stringContaining("limited") });
  });

  it("puts the store in a metro", async () => {
    signInAs(admin);
    const { cards } = await draft("draft_store_metro", { slug, metro: metroName });
    expect(cards[0]!.changes).toEqual([{ field: "Metro", from: "None", to: metroName }]);
    expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id })).toMatchObject({ ok: true });
    expect((await store()).metroId).toBe(metroId);
  });

  it("queues the courier registration again", async () => {
    signInAs(admin);
    await sql((tx) => tx.store.update({ where: { id: storeId }, data: { doordashRegistrationError: "Address rejected" } }));
    const { cards } = await draft("draft_courier_retry", { slug });
    expect(cards[0]!.changes[0]).toEqual({ field: "DoorDash", from: "Address rejected", to: "Queued again" });
    expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id })).toMatchObject({ ok: true });
    expect(await platformAdmin.auditLog.count({ where: { entityId: storeId, action: "store.courier_registration_retry", actorId: admin.id } })).toBe(1);
  });

  it("invites the store owner, and a card goes stale once another invite went out", async () => {
    signInAs(admin);
    const first = await draft("draft_owner_invite", { slug, email: `owner-${RUN}@example.com` });
    const second = await draft("draft_owner_invite", { slug, email: `owner2-${RUN}@example.com` });
    expect(first.cards[0]!.warning).toContain("cannot be unsent");
    expect(await confirmAdminAssistantDraft({ draftId: first.cards[0]!.id })).toMatchObject({ ok: true });
    expect(await platformAdmin.storeInvite.count({ where: { storeId, email: `owner-${RUN}@example.com` } })).toBe(1);
    expect(await confirmAdminAssistantDraft({ draftId: second.cards[0]!.id })).toMatchObject({ ok: false, code: "stale" });
    expect(await platformAdmin.storeInvite.count({ where: { storeId, email: `owner2-${RUN}@example.com` } })).toBe(0);
  });

  it("changes the platform courier settings through the settings page's action, and goes stale when they changed", async () => {
    signInAs(admin);
    const next = courierBefore!.assignmentTimeoutSeconds === 600 ? 660 : 600;
    const { cards } = await draft("draft_courier_settings", { assignmentTimeoutSeconds: next });
    expect(cards[0]!.changes).toEqual([{ field: "Assignment timeout", from: `${courierBefore!.assignmentTimeoutSeconds} seconds`, to: `${next} seconds` }]);
    const stale = await draft("draft_courier_settings", { assignmentTimeoutSeconds: 900 });
    expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id })).toMatchObject({ ok: true });
    expect((await readCourierSettings()).assignmentTimeoutSeconds).toBe(next);
    expect(await confirmAdminAssistantDraft({ draftId: stale.cards[0]!.id })).toMatchObject({ ok: false, code: "stale" });
    expect((await readCourierSettings()).assignmentTimeoutSeconds).toBe(next);
  });

  it("adds a courier incident note", async () => {
    signInAs(admin);
    const { result, cards } = await draft("draft_incident_note", { orderId: ids.order, note: "Called DoorDash support." });
    expect(result).toMatchObject({ drafted: true });
    expect(cards[0]).toMatchObject({ storeName, title: "Note on courier incident, order 832" });
    expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id })).toMatchObject({ ok: true });
    const notes = await sql((tx) => tx.courierIncidentNote.findMany({ where: { orderId: ids.order } }));
    expect(notes.map((note) => note.body)).toEqual(["Called DoorDash support."]);
  });

  it("labels a flagged AI chat", async () => {
    signInAs(admin);
    const { cards } = await draft("draft_conversation_label", { kind: "copilot", conversationId: ids.copilotChat, label: "tone", note: "Too curt." });
    expect(cards[0]!.changes).toEqual([{ field: "Review label", from: "None from you", to: "Tone" }]);
    expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id })).toMatchObject({ ok: true });
    const flags = await sql((tx) => tx.aiReviewFlag.findMany({ where: { copilotConversationId: ids.copilotChat } }));
    expect(flags.map((flag) => [flag.label, flag.note])).toEqual([["tone", "Too curt."]]);
  });

  it("sends only the reply the admin edited, and goes stale when the customer wrote again", async () => {
    signInAs(admin);
    const later = await draft("draft_support_reply", { threadId: ids.thread, reply: "We are on it." });
    const { cards } = await draft("draft_support_reply", { threadId: ids.thread, reply: "Sorry, we will refund the missing item." });
    expect(cards[0]!.editable).toMatchObject({ label: "Reply", text: "Sorry, we will refund the missing item." });
    expect(await sql((tx) => tx.supportMessage.count({ where: { threadId: ids.thread } }))).toBe(0);

    const sent = await confirmAdminAssistantDraft({ draftId: cards[0]!.id, text: "Sorry about that. The store will refund the missing yams today." });
    expect(sent).toMatchObject({ ok: true, draft: { editable: { text: "Sorry about that. The store will refund the missing yams today." } } });
    const messages = await sql((tx) => tx.supportMessage.findMany({ where: { threadId: ids.thread } }));
    expect(messages.map((message) => [message.sender, message.body])).toEqual([["platform", "Sorry about that. The store will refund the missing yams today."]]);

    await sql((tx) => tx.supportThread.update({ where: { id: ids.thread }, data: { lastCustomerAt: new Date() } }));
    expect(await confirmAdminAssistantDraft({ draftId: later.cards[0]!.id })).toMatchObject({ ok: false, code: "stale" });
    expect(await sql((tx) => tx.supportMessage.count({ where: { threadId: ids.thread } }))).toBe(1);
  });

  it("checks new applications, then approves one and rejects one with a reason on confirm", async () => {
    signInAs(admin);
    const book = createReadBook();
    const tools = adminAssistantTools({ actor: admin, conversationId, book, now: new Date() }) as unknown as Record<string, { execute?: (input: unknown, opts: unknown) => Promise<unknown> }>;
    const checked = (await tools.check_applications!.execute!({}, { toolCallId: "t", messages: [] })) as { applications: Array<Record<string, unknown>> };
    const mine = checked.applications.find((row) => row.applicationId === ids.application);
    expect(mine).toMatchObject({
      missing: ["no website or social link"],
      duplicates: [`another waiting application, Reject ${RUN}, is at the same address`],
      metro: expect.any(String),
      outsideMetro: false,
    });

    const newSlug = `apply-${RUN}`;
    const { cards } = await draft("draft_application_decision", {
      decisions: [
        { applicationId: ids.application, decision: "approve", slug: newSlug },
        { applicationId: ids.application2, decision: "reject", reason: "Outside our metros" },
      ],
    });
    expect(cards.map((card) => card.title)).toEqual(["Approve store application", "Reject store application"]);
    expect(cards[1]!.warning).toContain(`reject-${RUN}@example.com`);

    expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id })).toMatchObject({ ok: true });
    expect(await confirmAdminAssistantDraft({ draftId: cards[1]!.id, text: "No delivery area yet" })).toMatchObject({ ok: true });
    const [approved, rejected] = await Promise.all([
      platformAdmin.storeApplication.findUniqueOrThrow({ where: { id: ids.application } }),
      platformAdmin.storeApplication.findUniqueOrThrow({ where: { id: ids.application2 } }),
    ]);
    expect(approved.status).toBe("approved");
    expect((await platformAdmin.store.findUniqueOrThrow({ where: { id: approved.storeId! } })).slug).toBe(newSlug);
    expect(rejected).toMatchObject({ status: "rejected", rejectReason: "No delivery area yet" });
    expect(await platformAdmin.auditLog.count({ where: { entityId: ids.application2, action: "store_application.reject", actorId: admin.id } })).toBe(1);
  });
});
