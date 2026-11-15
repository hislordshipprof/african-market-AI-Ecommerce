"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { platformAdmin, platformAdminTransaction } from "../db";
import { parseInput, readFormFields } from "../security/parse-input";
import { findCourierIncidentDetail, findCourierIncidents, isIncidentId, NOTE_MAX, type IncidentFilters } from "./courier-incidents-query";
import { requirePlatformAdmin } from "./session";

/** The courier incident log (#536). Every read is cross-store, so every entry point checks for a platform admin. */
export async function listCourierIncidents(filters: IncidentFilters) {
  await requirePlatformAdmin();
  const checkedAt = new Date();
  return { checkedAt, ...(await platformAdminTransaction((tx) => findCourierIncidents(tx, filters))) };
}

export async function listIncidentStores() {
  await requirePlatformAdmin();
  return platformAdmin.store.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
}

export async function getCourierIncident(orderId: string) {
  await requirePlatformAdmin();
  const checkedAt = new Date();
  const detail = await platformAdminTransaction((tx) => findCourierIncidentDetail(tx, orderId));
  return detail && { checkedAt, ...detail };
}

const FIELDS = ["orderId", "body", "intent"] as const;
const SCHEMAS = {
  orderId: z.string().refine(isIncidentId, "Unknown incident."),
  body: z.string().trim().min(1, "Write a note.").max(NOTE_MAX, `Keep the note to ${NOTE_MAX.toLocaleString("en-US")} characters.`),
  intent: z.enum(["note", "resolve"], "Choose to add a note or resolve."),
};

export interface IncidentNoteState {
  saved?: boolean;
  error?: string;
  fieldErrors?: Partial<Record<"body" | "intent", string>>;
  /** What the admin wrote, so a refused note keeps it. */
  body?: string;
}

/**
 * A platform admin adds a note to an incident, or resolves it with one. The note and its audit row are written in one
 * transaction, on the incident's own store.
 */
export async function addCourierIncidentNoteAction(_prev: IncidentNoteState, formData: FormData): Promise<IncidentNoteState> {
  const session = await requirePlatformAdmin();
  const raw = readFormFields(formData, FIELDS);
  const body = typeof raw.body === "string" ? raw.body : "";
  const orderId = parseInput(SCHEMAS.orderId, raw.orderId);
  if (!orderId.ok) return { error: orderId.issues[0], body };
  const fieldErrors: IncidentNoteState["fieldErrors"] = {};
  const note = parseInput(SCHEMAS.body, raw.body);
  if (!note.ok) fieldErrors.body = note.issues[0];
  const intent = parseInput(SCHEMAS.intent, raw.intent);
  if (!intent.ok) fieldErrors.intent = intent.issues[0];
  if (!note.ok || !intent.ok) return { fieldErrors, body };

  const resolves = intent.data === "resolve";
  const saved = await platformAdminTransaction(async (tx) => {
    const [incident] = (await findCourierIncidents(tx, { orderId: orderId.data }, 1)).rows;
    if (!incident) return false;
    const created = await tx.courierIncidentNote.create({
      data: { storeId: incident.storeId, orderId: incident.orderId, authorId: session.user.id, authorEmail: session.user.email, body: note.data, resolves },
    });
    await tx.auditLog.create({
      data: {
        storeId: incident.storeId,
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: resolves ? "courier_incident.resolve" : "courier_incident.note",
        entityType: "courier_incident",
        entityId: incident.orderId,
        before: { state: incident.state },
        after: { state: resolves ? "resolved" : incident.state, noteId: created.id, body: note.data },
      },
    });
    return true;
  });
  if (!saved) return { error: "This order has no courier incident.", body };
  revalidatePath("/admin/couriers/incidents");
  revalidatePath(`/admin/couriers/incidents/${orderId.data}`);
  return { saved: true };
}
