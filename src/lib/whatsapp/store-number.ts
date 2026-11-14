import { z } from "zod";
import {
  beginStoreWhatsAppNumberLink,
  disconnectStoreWhatsAppNumberRow,
  finishStoreWhatsAppNumberLink,
  readStoreWhatsAppNumber,
  StoreWhatsAppNumberTakenError,
  type StoreWhatsAppNumberRow,
} from "../db";
import { readWhatsAppConfig } from "./config";
import { WhatsAppNotConfiguredError, whatsappErrorCode } from "./errors";
import { getWhatsAppProvider, whatsappProviderKind } from "./index";
import { normalizeOwnerPhone, PHONE_FORMAT_ERROR } from "./phone";
import { hasTokenKey, sealBusinessToken } from "./token-box";

export const IDS_FORMAT_ERROR = "Enter the WhatsApp Business account id and phone number id as digits";
export const PLATFORM_NUMBER_ERROR = "That is the platform's own WhatsApp number. Link the store's number instead.";
export const ALREADY_LINKED_ERROR = "This WhatsApp number is linked to another store.";
export const NOT_SET_UP_ERROR = "WhatsApp isn't set up yet";
export const LINK_FAILED_ERROR = "Meta did not accept this number. Check the ids and try again.";

export type StoreNumberView = StoreWhatsAppNumberRow;

export interface StoreNumberActor {
  storeId: string;
  actorId: string;
  actorEmail: string;
}

/** Meta's ids are numeric; matched whole, never as a pattern built from input. */
const metaId = z.string().trim().regex(/^\d{5,20}$/);

export const linkStoreNumberSchema = z.strictObject({
  wabaId: metaId,
  phoneNumberId: metaId,
  coexistence: z.boolean(),
  displayNumber: z.string().trim().max(32).optional(),
  code: z.string().trim().min(1).max(1024).optional(),
});

export type LinkStoreNumberInput = z.input<typeof linkStoreNumberSchema>;

function logLink(event: string, storeId: string, extra: Record<string, string> = {}): void {
  console.info(JSON.stringify({ event, storeId, ...extra }));
}

/**
 * Links the store's own WhatsApp number (#558): a pending row is committed
 * first (one link in flight per store; a retry of a registered link is a
 * no-op), then the provider (Embedded Signup, or the fake taking ids from a
 * form) returns the store's business token, which is sealed before it is
 * written. The token never leaves this function.
 */
export async function linkStoreNumber(
  actor: StoreNumberActor,
  raw: LinkStoreNumberInput,
): Promise<{ ok: true } | { error: string }> {
  const parsed = linkStoreNumberSchema.safeParse(raw);
  if (!parsed.success) return { error: IDS_FORMAT_ERROR };
  const input = parsed.data;
  let displayNumber: string | undefined;
  if (input.displayNumber) {
    const phone = normalizeOwnerPhone(input.displayNumber);
    if (!phone.ok) return { error: PHONE_FORMAT_ERROR };
    displayNumber = phone.e164;
  }
  if (input.phoneNumberId === readWhatsAppConfig().phoneNumberId) return { error: PLATFORM_NUMBER_ERROR };
  if (!hasTokenKey()) {
    console.error(JSON.stringify({ event: "whatsapp_token_key_missing", storeId: actor.storeId }));
    return { error: NOT_SET_UP_ERROR };
  }

  try {
    if ((await beginStoreWhatsAppNumberLink({ ...actor, ...input })) === "linked") return { ok: true };
  } catch (error) {
    if (error instanceof StoreWhatsAppNumberTakenError) return { error: ALREADY_LINKED_ERROR };
    throw error;
  }

  let connected;
  try {
    connected = await getWhatsAppProvider().connectStoreNumber({ ...input, displayNumber });
  } catch (error) {
    const failureCode = whatsappErrorCode(error);
    await finishStoreWhatsAppNumberLink(actor.storeId, input.phoneNumberId, { status: "failed", failureCode });
    logLink("whatsapp_number_link_failed", actor.storeId, { code: failureCode });
    return { error: error instanceof WhatsAppNotConfiguredError ? NOT_SET_UP_ERROR : LINK_FAILED_ERROR };
  }

  const sealedToken = sealBusinessToken(connected.businessToken, {
    storeId: actor.storeId,
    phoneNumberId: input.phoneNumberId,
  });
  const registered = await finishStoreWhatsAppNumberLink(actor.storeId, input.phoneNumberId, {
    status: "registered",
    displayNumber: connected.displayNumber,
    sealedToken,
  });
  if (!registered) {
    logLink("whatsapp_number_link_superseded", actor.storeId);
    return { error: LINK_FAILED_ERROR };
  }
  logLink("whatsapp_number_linked", actor.storeId);
  return { ok: true };
}

/**
 * How a number can be linked here: "form" with the fake (ids typed in),
 * "meta" with real keys (Embedded Signup popup, not built yet: #558 builds
 * against the fake), "unavailable" with no keys.
 */
export type StoreNumberLinkMode = "form" | "meta" | "unavailable";

export function storeNumberLinkMode(): StoreNumberLinkMode {
  const kind = whatsappProviderKind();
  if (kind === "fake") return "form";
  return kind === "real" ? "meta" : "unavailable";
}

export function getStoreNumber(storeId: string): Promise<StoreNumberView | null> {
  return readStoreWhatsAppNumber(storeId);
}

/** Stops routing and drops the token. The number stays registered with Meta; the store removes our app there. */
export async function disconnectStoreNumber(actor: StoreNumberActor): Promise<{ ok: true }> {
  await disconnectStoreWhatsAppNumberRow(actor.storeId, actor.actorId, actor.actorEmail);
  logLink("whatsapp_number_disconnected", actor.storeId);
  return { ok: true };
}
