"use server";

import { z } from "zod";
import { requirePlatformAdmin } from "../admin/session";
import { platformAdmin } from "../db";
import { parseInput, readFormFields } from "../security/parse-input";
import { requireStoreOwner } from "../store-admin/session";
import {
  disconnectStoreNumber,
  IDS_FORMAT_ERROR,
  linkStoreNumber,
  type LinkStoreNumberInput,
  type StoreNumberActor,
} from "./store-number";

export type StoreNumberActionResult = { ok: true } | { error: string };

const LINK_FIELDS = ["wabaId", "phoneNumberId", "displayNumber", "coexistence", "code"] as const;
const field = z.string().max(1024).nullable();
const linkFieldsSchema = z.strictObject({
  wabaId: field,
  phoneNumberId: field,
  displayNumber: field,
  coexistence: field,
  code: field,
});

/** Form fields to service input. An unticked checkbox is absent: coexistence off. */
function readLinkInput(formData: FormData): LinkStoreNumberInput | null {
  const fields = parseInput(linkFieldsSchema, readFormFields(formData, LINK_FIELDS));
  if (!fields.ok) return null;
  const { wabaId, phoneNumberId, displayNumber, coexistence, code } = fields.data;
  return {
    wabaId: wabaId ?? "",
    phoneNumberId: phoneNumberId ?? "",
    coexistence: coexistence === "on",
    ...(displayNumber?.trim() ? { displayNumber } : {}),
    ...(code?.trim() ? { code } : {}),
  };
}

async function link(actor: StoreNumberActor, formData: FormData): Promise<StoreNumberActionResult> {
  const input = readLinkInput(formData);
  if (!input) return { error: IDS_FORMAT_ERROR };
  try {
    return await linkStoreNumber(actor, input);
  } catch (error) {
    logActionFailure("whatsapp_number_link_action_failed", error);
    return { error: "Something went wrong. Try again." };
  }
}

async function disconnect(actor: StoreNumberActor): Promise<StoreNumberActionResult> {
  try {
    return await disconnectStoreNumber(actor);
  } catch (error) {
    logActionFailure("whatsapp_number_disconnect_action_failed", error);
    return { error: "Something went wrong. Try again." };
  }
}

/** The signed-in owner's store only; any posted storeId is ignored. */
export async function linkStoreNumberAction(formData: FormData): Promise<StoreNumberActionResult> {
  const session = await requireStoreOwner();
  return link({ storeId: session.store.id, actorId: session.user.id, actorEmail: session.user.email }, formData);
}

export async function disconnectStoreNumberAction(): Promise<StoreNumberActionResult> {
  const session = await requireStoreOwner();
  return disconnect({ storeId: session.store.id, actorId: session.user.id, actorEmail: session.user.email });
}

async function adminActor(
  session: { user: { id: string; email: string } },
  formData: FormData,
): Promise<StoreNumberActor | { error: string }> {
  const fields = parseInput(z.object({ storeId: z.string().min(1).max(200) }), readFormFields(formData, ["storeId"]));
  if (!fields.ok) return { error: "Store not found" };
  const store = await platformAdmin.store.findUnique({ where: { id: fields.data.storeId }, select: { id: true } });
  if (!store) return { error: "Store not found" };
  return { storeId: store.id, actorId: session.user.id, actorEmail: session.user.email };
}

export async function adminLinkStoreNumberAction(formData: FormData): Promise<StoreNumberActionResult> {
  const actor = await adminActor(await requirePlatformAdmin(), formData);
  if ("error" in actor) return actor;
  return link(actor, formData);
}

export async function adminDisconnectStoreNumberAction(formData: FormData): Promise<StoreNumberActionResult> {
  const actor = await adminActor(await requirePlatformAdmin(), formData);
  if ("error" in actor) return actor;
  return disconnect(actor);
}

/** Error class name only: a message could carry an id or token. */
function logActionFailure(event: string, error: unknown): void {
  console.error(JSON.stringify({ event, error: error instanceof Error ? error.name : "unknown" }));
}
