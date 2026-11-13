"use server";

import { z } from "zod";
import { requireStoreMember, requireStoreOwner } from "../store-admin/session";
import { DELIVERY_PROOF_MAX_BYTES } from "../order/delivery-proof";
import { parseInput } from "../security/parse-input";
import { revalidateStorefront } from "../storefront/cache";
import {
  REPORT_PHOTO_INVALID,
  REPORT_TOO_LONG,
  confirmOwnerReport,
  createOwnerReport,
  type ConfirmReportResult,
  type CreateReportResult,
} from "./owner-report";
import { FIXED_ERROR, MESSAGE_MAX } from "./types";

const voiceSchema = z.strictObject({ transcript: z.string().max(MESSAGE_MAX) });
const photoSchema = z.strictObject({ type: z.enum(["invoice_photo", "shelf_photo"]) });
const confirmSchema = z.strictObject({
  reportId: z.string().min(1).max(200),
  itemIds: z.array(z.string().min(1).max(200)).max(100),
});

/** Any store member: a voice note transcribed in the browser, or typed. */
export async function submitVoiceReport(input: unknown): Promise<CreateReportResult> {
  const session = await requireStoreMember();
  const parsed = parseInput(voiceSchema, input);
  if (!parsed.ok) {
    const transcript = (input as { transcript?: unknown } | null)?.transcript;
    const tooLong = typeof transcript === "string" && transcript.length > MESSAGE_MAX;
    return { ok: false, code: "invalid_request", message: tooLong ? REPORT_TOO_LONG : FIXED_ERROR };
  }
  try {
    return await createOwnerReport(session.store.id, { id: session.user.id, email: session.user.email }, {
      type: "voice",
      transcript: parsed.data.transcript,
    });
  } catch (error) {
    console.error("[copilot] report failed", { errorType: error instanceof Error ? error.name : "Error" });
    return { ok: false, code: "copilot_unavailable", message: FIXED_ERROR };
  }
}

/** Any store member: one invoice or shelf photo (`type`, `photo`). */
export async function submitPhotoReport(form: FormData): Promise<CreateReportResult> {
  const session = await requireStoreMember();
  const parsed = parseInput(photoSchema, { type: form.get("type") });
  const photo = form.get("photo");
  const file = photo instanceof File && photo.size > 0 ? photo : null;
  if (!parsed.ok || !file || file.size > DELIVERY_PROOF_MAX_BYTES) {
    return { ok: false, code: "photo_invalid", message: REPORT_PHOTO_INVALID };
  }
  try {
    return await createOwnerReport(session.store.id, { id: session.user.id, email: session.user.email }, {
      type: parsed.data.type,
      photo: new Uint8Array(await file.arrayBuffer()),
    });
  } catch (error) {
    console.error("[copilot] report failed", { errorType: error instanceof Error ? error.name : "Error" });
    return { ok: false, code: "copilot_unavailable", message: FIXED_ERROR };
  }
}

/** Owner only: writes the ticked lines and rejects the other matched lines of the report. */
export async function confirmOwnerReportItems(input: unknown): Promise<ConfirmReportResult> {
  const session = await requireStoreOwner();
  const parsed = parseInput(confirmSchema, input);
  if (!parsed.ok) return { ok: false, code: "not_found" };
  try {
    const result = await confirmOwnerReport(session.store.id, parsed.data.reportId, parsed.data.itemIds, {
      id: session.user.id,
      email: session.user.email,
    });
    if (result.ok) revalidateStorefront(session.store.id);
    return result;
  } catch (error) {
    console.error("[copilot] report confirm failed", { errorType: error instanceof Error ? error.name : "Error" });
    return { ok: false, code: "failed" };
  }
}
