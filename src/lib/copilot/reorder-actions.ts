"use server";

import { z } from "zod";
import { storeMayUse } from "../billing/plan";
import { requireStoreOwner } from "../store-admin/session";
import { parseInput } from "../security/parse-input";
import { QUANTITY_MAX } from "./types";
import { COVER_DAYS_MAX, LEAD_DAYS_MAX, REORDER_LINES_MAX, saveReorderList, setReorderDays, type SaveResult } from "./reorder-list";

const PRO_ONLY = "Reorder suggestions are on the Pro plan.";

const daysSchema = z.strictObject({
  leadDays: z.number().int().min(0).max(LEAD_DAYS_MAX),
  coverDays: z.number().int().min(1).max(COVER_DAYS_MAX),
});

const listSchema = z.strictObject({
  lines: z.array(z.strictObject({
    listingId: z.string().min(1).max(200),
    quantity: z.number().int().min(0).max(QUANTITY_MAX).nullable(),
  })).max(REORDER_LINES_MAX),
});

export async function updateReorderDays(input: unknown): Promise<SaveResult> {
  const session = await requireStoreOwner();
  if (!(await storeMayUse(session.store.id, "reorder-suggestions"))) return { ok: false, message: PRO_ONLY };
  const parsed = parseInput(daysSchema, input);
  if (!parsed.ok) return { ok: false, message: `Lead time 0 to ${LEAD_DAYS_MAX} days, cover 1 to ${COVER_DAYS_MAX} days, whole days.` };
  await setReorderDays(session.store.id, parsed.data, { id: session.user.id, email: session.user.email });
  return { ok: true };
}

export async function saveReorder(input: unknown): Promise<SaveResult> {
  const session = await requireStoreOwner();
  if (!(await storeMayUse(session.store.id, "reorder-suggestions"))) return { ok: false, message: PRO_ONLY };
  const parsed = parseInput(listSchema, input);
  if (!parsed.ok) return { ok: false, message: "Whole numbers only." };
  return saveReorderList(session.store.id, parsed.data.lines, { id: session.user.id, email: session.user.email });
}
