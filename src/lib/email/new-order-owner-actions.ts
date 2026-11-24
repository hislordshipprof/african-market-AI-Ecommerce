"use server";

import { z } from "zod";
import { requireStoreMember } from "../store-admin/session";
import { parseInput } from "../security/parse-input";
import { setNewOrderEmail } from "./new-order-owner";

/** An owner turns their own new-order email on or off (#785). The store and user come from the session. */
export async function setNewOrderEmailAction(on: unknown) {
  const session = await requireStoreMember();
  if (session.membership.role !== "owner") return { ok: false as const, error: "Only owners get the new-order email." };
  const parsed = parseInput(z.boolean(), on);
  if (!parsed.ok) return { ok: false as const, error: "Choose on or off." };
  await setNewOrderEmail(session.store.id, session.user.id, parsed.data);
  return { ok: true as const };
}
