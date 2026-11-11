"use server";

import { z } from "zod";
import { requireStoreOwner } from "../store-admin/session";
import { parseInput } from "../security/parse-input";
import { setDigestHour } from "./digest";

const digestHourSchema = z.strictObject({ hour: z.number().int().min(0).max(23) });

export async function updateDigestHour(input: unknown): Promise<{ ok: boolean }> {
  const session = await requireStoreOwner();
  const parsed = parseInput(digestHourSchema, input);
  if (!parsed.ok) return { ok: false };
  await setDigestHour(session.store.id, parsed.data.hour, { id: session.user.id, email: session.user.email });
  return { ok: true };
}
