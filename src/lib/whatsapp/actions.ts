"use server";

import { z } from "zod";
import { requireStoreOwner } from "../store-admin/session";
import { parseInput, readFormFields } from "../security/parse-input";
import { PHONE_FORMAT_ERROR } from "./phone";
import { removeOwnerLink, startOwnerLink } from "./owner-link";

export type WhatsAppLinkActionResult = { ok: true } | { error: string };

export async function startWhatsAppLinkAction(formData: FormData): Promise<WhatsAppLinkActionResult> {
  const session = await requireStoreOwner();
  const fields = parseInput(
    z.strictObject({ phone: z.string().trim().min(1).max(32) }),
    readFormFields(formData, ["phone"]),
  );
  if (!fields.ok) return { error: PHONE_FORMAT_ERROR };
  try {
    return await startOwnerLink(
      { storeId: session.store.id, userId: session.user.id, actorEmail: session.user.email },
      fields.data.phone,
    );
  } catch {
    return { error: "Something went wrong. Try again." };
  }
}

export async function removeWhatsAppLinkAction(): Promise<WhatsAppLinkActionResult> {
  const session = await requireStoreOwner();
  try {
    return await removeOwnerLink({
      storeId: session.store.id,
      userId: session.user.id,
      actorEmail: session.user.email,
    });
  } catch {
    return { error: "Something went wrong. Try again." };
  }
}
