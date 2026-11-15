import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateTOTP } from "../../../e2e/totp";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

vi.mock("next/headers", () => ({ headers: async () => headerState }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
// AC6: the pages and the action read the database only. Loading Inngest at all fails this file.
vi.mock("../inngest/client", () => {
  throw new Error("The courier incident log must not load Inngest");
});

import IncidentsPage from "@/app/admin/(shell)/couriers/incidents/page";
import IncidentPage from "@/app/admin/(shell)/couriers/incidents/[orderId]/page";
import { addCourierIncidentNoteAction, getCourierIncident, listCourierIncidents } from "./courier-incidents";
import { auth } from "../auth";
import { testPrismaClient } from "../test-prisma";
import { authPrisma, platformAdmin, storeScopedTransaction } from "../db";

const BASE = "http://localhost:3000/api/auth";
const suffix = `${Date.now()}-ci536`;
const password = "GuardPass-123!";
const emails = {
  admin: `ci536-admin-${suffix}@test.example`,
  owner: `ci536-owner-${suffix}@test.example`,
  customer: `ci536-customer-${suffix}@test.example`,
};
const storeA = crypto.randomUUID();
const storeB = crypto.randomUUID();
const ids = { orderA: "", orderB: "", quietOrder: "", deliveryA: "" };

function collectCookies(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).join("; ");
}

async function authPost(path: string, body: unknown, cookies?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies) headers.cookie = cookies;
  return auth.handler(new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function signUpAndIn(email: string): Promise<{ userId: string; cookies: string }> {
  const signedUp = await authPost("/sign-up/email", { email, password, name: "Incident 536" });
  expect(signedUp.status, await signedUp.clone().text()).toBe(200);
  const user = await authPrisma.user.findFirstOrThrow({ where: { email } });
  const signedIn = await authPost("/sign-in/email", { email, password });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  return { userId: user.id, cookies: collectCookies(signedIn) };
}

async function withVerified2FA(cookies: string): Promise<string> {
  const enabled = await authPost("/two-factor/enable", { password }, cookies);
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret");
  if (!secret) throw new Error("TOTP URI has no secret");
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
  expect(verified.status, await verified.clone().text()).toBe(200);
  return collectCookies(verified) || cookies;
}

async function asPlatformAdmin<T>(fn: (tx: Parameters<Parameters<typeof authPrisma.$transaction>[0]>[0]) => Promise<T>): Promise<T> {
  return authPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx);
  });
}

function noteForm(orderId: string, body: string, intent: "note" | "resolve" = "note"): FormData {
  const data = new FormData();
  data.set("orderId", orderId);
  data.set("body", body);
  data.set("intent", intent);
  return data;
}

const auditRows = (orderId: string) =>
  platformAdmin.auditLog.findMany({ where: { entityType: "courier_incident", entityId: orderId }, orderBy: { createdAt: "asc" } });
const noteCount = () => asPlatformAdmin((tx) => tx.courierIncidentNote.count({ where: { storeId: { in: [storeA, storeB] } } }));

describe.skipIf(!process.env.DATABASE_URL)("courier incident detail and notes (#536)", () => {
  const sessions: Record<keyof typeof emails, { userId: string; cookies: string }> = {} as never;

  beforeAll(async () => {
    for (const role of Object.keys(emails) as Array<keyof typeof emails>) sessions[role] = await signUpAndIn(emails[role]);
    await authPrisma.user.update({ where: { id: sessions.admin.userId }, data: { role: "platform_admin" } });
    sessions.admin.cookies = await withVerified2FA(sessions.admin.cookies);
    sessions.owner.cookies = await withVerified2FA(sessions.owner.cookies);
    await asPlatformAdmin(async (tx) => {
      for (const [id, name] of [[storeA, "Incident A"], [storeB, "Incident B"]]) {
        await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${id}, ${`${name} ${suffix}`}, ${`ci536-${id.slice(0, 8)}-${suffix}`}, 'active', now())`;
      }
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeA}, ${sessions.owner.userId}, 'owner', now())`;
      const order = async (storeId: string, number: number) => {
        const customer = await tx.customer.create({ data: { storeId, name: "Ada Obi", phone: "+13015550199" } });
        return (await tx.order.create({
          data: { storeId, customerId: customer.id, number, status: "COURIER_REQUESTED", fulfillment: "courier", subtotalCents: 4000, bufferCents: 0, totalCents: 4000, totalAuthorizedCents: 4000 },
        })).id;
      };
      ids.orderA = await order(storeA, 101);
      ids.orderB = await order(storeB, 201);
      ids.quietOrder = await order(storeA, 102);
      const delivery = await tx.delivery.create({
        data: { storeId: storeA, orderId: ids.orderA, provider: "doordash", externalId: `ci536-${suffix}`, status: "cancelled", quoteFeeCents: 899, createdAt: new Date("2026-03-10T12:00:00Z") },
      });
      ids.deliveryA = delivery.id;
      await tx.deliveryEvent.create({
        data: {
          storeId: storeA,
          orderId: ids.orderA,
          deliveryId: delivery.id,
          externalEventId: "DASHER_CONFIRMED:1",
          type: "courier_assigned",
          payload: { event_name: "DASHER_CONFIRMED", dasher_name: "John D.", dasher_dropoff_phone_number: "+18555550100" },
          createdAt: new Date("2026-03-10T12:04:00Z"),
        },
      });
      await tx.deliveryEvent.create({
        data: {
          storeId: storeA,
          orderId: ids.orderA,
          deliveryId: delivery.id,
          externalEventId: "DELIVERY_CANCELLED:1",
          type: "cancelled",
          payload: { event_name: "DELIVERY_CANCELLED", cancellation_reason: "dasher_not_responding", dropoff_phone_number: "+13015550199", dropoff_contact_given_name: "Ada" },
          createdAt: new Date("2026-03-10T12:20:00Z"),
        },
      });
      await tx.deliveryEvent.create({
        data: { storeId: storeB, orderId: ids.orderB, type: "both_failed", payload: { options: ["cancel"] }, createdAt: new Date("2026-03-10T13:00:00Z") },
      });
    });
  }, 60_000);

  afterAll(async () => {
    const userIds = Object.values(sessions).map((s) => s.userId);
    // Notes are append-only for app_user; the owner role clears them.
    const owner = testPrismaClient();
    await owner.$executeRaw`DELETE FROM courier_incident_notes WHERE store_id IN (${storeA}, ${storeB})`;
    await owner.$disconnect();
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM delivery_events WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM deliveries WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM orders WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM customers WHERE store_id IN (${storeA}, ${storeB})`;
      for (const id of userIds) {
        await tx.$executeRaw`DELETE FROM audit_logs WHERE actor_id = ${id}`;
        await tx.$executeRaw`DELETE FROM store_memberships WHERE user_id = ${id}`;
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id = ${id}`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${id}`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id = ${id}`;
        await tx.$executeRaw`DELETE FROM users WHERE id = ${id}`;
      }
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${storeA}, ${storeB})`;
    });
  }, 30_000);

  it("AC3: the detail has the delivery's event timeline in order, with courier phones and customer contact redacted", async () => {
    headerState.set("cookie", sessions.admin.cookies);

    const detail = await getCourierIncident(ids.orderA);

    expect(detail?.incident).toMatchObject({ orderNumber: 101, storeId: storeA, kinds: ["provider_cancelled"], state: "open" });
    expect(detail?.events.map((e) => [e.type, e.provider])).toEqual([["courier_assigned", "doordash"], ["cancelled", "doordash"]]);
    expect(detail?.events[1].payload).toMatchObject({ cancellation_reason: "dasher_not_responding", dropoff_phone_number: "[redacted]", dropoff_contact_given_name: "[redacted]" });
    const rendered = JSON.stringify(detail);
    expect(rendered).not.toContain("5550199");
    expect(rendered).not.toContain("5550100");
    expect(rendered).toContain("John D.");
    expect(await getCourierIncident(ids.quietOrder)).toBeNull();
  });

  it("AC4: a platform admin adds a note, then resolves; each writes one audit row and the incident shows resolved", async () => {
    headerState.set("cookie", sessions.admin.cookies);

    expect(await addCourierIncidentNoteAction({}, noteForm(ids.orderA, "Called DoorDash support, case 4411."))).toMatchObject({ saved: true });
    expect((await getCourierIncident(ids.orderA))?.incident.state).toBe("open");
    expect(await addCourierIncidentNoteAction({}, noteForm(ids.orderA, "Store delivered it themselves.", "resolve"))).toMatchObject({ saved: true });

    const detail = await getCourierIncident(ids.orderA);
    expect(detail?.incident.state).toBe("resolved");
    expect(detail?.notes.map((n) => [n.body, n.resolves, n.authorEmail])).toEqual([
      ["Called DoorDash support, case 4411.", false, emails.admin],
      ["Store delivered it themselves.", true, emails.admin],
    ]);
    const audit = await auditRows(ids.orderA);
    expect(audit.map((a) => [a.action, a.storeId, a.actorId])).toEqual([
      ["courier_incident.note", storeA, sessions.admin.userId],
      ["courier_incident.resolve", storeA, sessions.admin.userId],
    ]);
    expect(audit[1].after).toMatchObject({ state: "resolved", body: "Store delivered it themselves." });
    const listed = await listCourierIncidents({ storeId: storeA });
    expect(listed.rows.map((r) => [r.orderNumber, r.state])).toEqual([[101, "resolved"]]);

    // A later incident event reopens it.
    await asPlatformAdmin((tx) =>
      tx.deliveryEvent.create({ data: { storeId: storeA, orderId: ids.orderA, type: "both_failed", payload: {}, createdAt: new Date(Date.now() + 60_000) } }),
    );
    expect((await getCourierIncident(ids.orderA))?.incident.state).toBe("open");
  });

  it("AC4: an empty or overlong note, a bad intent, or an order with no incident is refused and nothing is written", async () => {
    headerState.set("cookie", sessions.admin.cookies);
    const before = await noteCount();
    const auditBefore = (await auditRows(ids.orderA)).length;

    expect(await addCourierIncidentNoteAction({}, noteForm(ids.orderA, "   "))).toMatchObject({ fieldErrors: { body: expect.any(String) } });
    expect(await addCourierIncidentNoteAction({}, noteForm(ids.orderA, "x".repeat(1001)))).toMatchObject({ fieldErrors: { body: expect.any(String) } });
    const badIntent = noteForm(ids.orderA, "ok");
    badIntent.set("intent", "delete");
    expect((await addCourierIncidentNoteAction({}, badIntent)).saved).toBeUndefined();
    expect(await addCourierIncidentNoteAction({}, noteForm(ids.quietOrder, "No incident here"))).toMatchObject({ error: expect.any(String) });

    expect(await noteCount()).toBe(before);
    expect(await auditRows(ids.orderA)).toHaveLength(auditBefore);
    expect(await auditRows(ids.quietOrder)).toHaveLength(0);
  });

  it("AC4 RLS: store A cannot write a note on store B's order, nor read store B's notes", async () => {
    headerState.set("cookie", sessions.admin.cookies);
    expect(await addCourierIncidentNoteAction({}, noteForm(ids.orderB, "Platform note on B"))).toMatchObject({ saved: true });

    await expect(
      storeScopedTransaction(storeA, (tx) =>
        tx.$executeRaw`INSERT INTO courier_incident_notes (id, store_id, order_id, author_id, author_email, body) VALUES (${crypto.randomUUID()}, ${storeB}, ${ids.orderB}, ${sessions.owner.userId}, ${emails.owner}, 'cross-store')`,
      ),
    ).rejects.toThrow(/row-level security/);
    const seenByA = await storeScopedTransaction(storeA, (tx) => tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM courier_incident_notes WHERE store_id = ${storeB}`);
    expect(Number(seenByA[0].n)).toBe(0);
    const seenByB = await storeScopedTransaction(storeB, (tx) => tx.$queryRaw<Array<{ body: string }>>`SELECT body FROM courier_incident_notes`);
    expect(seenByB.map((r) => r.body)).toEqual(["Platform note on B"]);
    // Append-only: store B can read the platform's note on its order but cannot delete it.
    await expect(storeScopedTransaction(storeB, (tx) => tx.$executeRaw`DELETE FROM courier_incident_notes`)).rejects.toThrow(/permission denied/);
  });

  it("only a 2FA-verified platform admin: a store owner, a customer and a signed-out visitor are sent to sign-in and nothing is written", async () => {
    const before = await noteCount();
    for (const cookies of [sessions.owner.cookies, sessions.customer.cookies, null]) {
      if (cookies) headerState.set("cookie", cookies);
      else headerState.delete("cookie");
      await expect(IncidentsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("REDIRECT:/admin/sign-in");
      await expect(IncidentPage({ params: Promise.resolve({ orderId: ids.orderA }) })).rejects.toThrow("REDIRECT:/admin/sign-in");
      await expect(listCourierIncidents({ storeId: storeA })).rejects.toThrow("REDIRECT:/admin/sign-in");
      await expect(getCourierIncident(ids.orderA)).rejects.toThrow("REDIRECT:/admin/sign-in");
      await expect(addCourierIncidentNoteAction({}, noteForm(ids.orderA, "owner note", "resolve"))).rejects.toThrow("REDIRECT:/admin/sign-in");
    }
    expect(await noteCount()).toBe(before);
  });

  it("the pages render for the admin; an order with no incident is not found", async () => {
    headerState.set("cookie", sessions.admin.cookies);
    expect(await IncidentsPage({ searchParams: Promise.resolve({ store: storeA }) })).toBeTruthy();
    expect(await IncidentPage({ params: Promise.resolve({ orderId: ids.orderA }) })).toBeTruthy();
    await expect(IncidentPage({ params: Promise.resolve({ orderId: ids.quietOrder }) })).rejects.toThrow("NOT_FOUND");
  });
});
