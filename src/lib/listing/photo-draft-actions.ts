"use server";

import { z } from "zod";
import { FIXED_ERROR } from "../copilot/types";
import { DELIVERY_PROOF_MAX_BYTES } from "../order/delivery-proof";
import { parseInput } from "../security/parse-input";
import { READ_ONLY_MESSAGE, requireStoreOwner, requireStoreWriter } from "../store-admin/session";
import { revalidateStorefront } from "../storefront/cache";
import {
  PHOTO_INVALID,
  createShelfPhotoDrafts,
  dismissDrafts,
  publishDrafts,
  type PhotoDraftResult,
  type PublishResult,
} from "./photo-drafts";

const publishSchema = z.strictObject({
  picks: z.array(z.strictObject({
    draftId: z.string().min(1).max(200),
    priceCents: z.number().int(),
    priceConfirmed: z.boolean(),
    masterProductId: z.string().min(1).max(200).nullable().optional(),
  })).min(1).max(200),
});
const dismissSchema = z.strictObject({ draftIds: z.array(z.string().min(1).max(200)).min(1).max(200) });

/** Any store member with write access: one shelf photo (`photo`) becomes pending drafts. */
export async function uploadShelfPhoto(form: FormData): Promise<PhotoDraftResult | { ok: false; code: "read_only"; message: string }> {
  const session = await requireStoreWriter();
  if (!session) return { ok: false, code: "read_only", message: READ_ONLY_MESSAGE };
  const photo = form.get("photo");
  const file = photo instanceof File && photo.size > 0 ? photo : null;
  if (!file || file.size > DELIVERY_PROOF_MAX_BYTES) return { ok: false, code: "photo_invalid", message: PHOTO_INVALID };
  try {
    return await createShelfPhotoDrafts(session.store.id, { id: session.user.id, email: session.user.email }, new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    console.error("[photo-drafts] upload failed", { errorType: error instanceof Error ? error.name : "Error" });
    return { ok: false, code: "copilot_unavailable", message: FIXED_ERROR };
  }
}

/** Owner only: publishes drafts whose price the owner set or checked. */
export async function publishListingDrafts(input: unknown): Promise<{ ok: true; result: PublishResult } | { ok: false; message: string }> {
  const session = await requireStoreOwner();
  const parsed = parseInput(publishSchema, input);
  if (!parsed.ok) return { ok: false, message: FIXED_ERROR };
  try {
    const result = await publishDrafts(session.store.id, { id: session.user.id, email: session.user.email }, parsed.data.picks);
    if (result.listingIds.length > 0) revalidateStorefront(session.store.id);
    return { ok: true, result };
  } catch (error) {
    console.error("[photo-drafts] publish failed", { errorType: error instanceof Error ? error.name : "Error" });
    return { ok: false, message: FIXED_ERROR };
  }
}

/** Owner only: drops drafts without listing them. */
export async function dismissListingDrafts(input: unknown): Promise<{ ok: true; count: number } | { ok: false; message: string }> {
  const session = await requireStoreOwner();
  const parsed = parseInput(dismissSchema, input);
  if (!parsed.ok) return { ok: false, message: FIXED_ERROR };
  const count = await dismissDrafts(session.store.id, { id: session.user.id, email: session.user.email }, parsed.data.draftIds);
  return { ok: true, count };
}
