import { requireStoreOwner } from "@/lib/store-admin/session";
import { canSendWhatsApp } from "@/lib/whatsapp";
import { getOwnerLink } from "@/lib/whatsapp/owner-link";
import { getStoreNumber, storeNumberLinkMode } from "@/lib/whatsapp/store-number";
import { StoreNumberPanel } from "./store-number-panel";
import { WhatsAppLinkForm, type LinkState } from "./whatsapp-link-form";

export const dynamic = "force-dynamic";

/** "+14045550123" → "+1 (404) 555-0123"; other countries stay in E.164. */
function displayNumber(e164: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return us ? `+1 (${us[1]}) ${us[2]}-${us[3]}` : e164;
}

export default async function WhatsAppPage() {
  const session = await requireStoreOwner();
  const [link, storeNumber] = await Promise.all([
    getOwnerLink(session.store.id, session.user.id),
    getStoreNumber(session.store.id),
  ]);

  let state: LinkState;
  if (!link) {
    state = { kind: "none" };
  } else if (link.verified) {
    const since = link.verifiedAt
      ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: session.store.timezone }).format(link.verifiedAt)
      : null;
    const pending = link.codeLive && link.pendingPhoneNumber
      ? { phone: link.pendingPhoneNumber, display: displayNumber(link.pendingPhoneNumber) }
      : null;
    state = {
      kind: "linked",
      phone: link.phoneNumber,
      display: displayNumber(link.phoneNumber),
      since,
      pending,
      notices: { optInAlerts: link.optInAlerts, optInDigest: link.optInDigest },
    };
  } else {
    state = {
      kind: link.codeLive ? "waiting" : "expired",
      phone: link.phoneNumber,
      display: displayNumber(link.phoneNumber),
    };
  }

  return (
    <WhatsAppLinkForm
      storeName={session.store.name}
      storeSlug={session.store.slug}
      configured={canSendWhatsApp()}
      state={state}
    >
      <StoreNumberPanel
        storeName={session.store.name}
        mode={storeNumberLinkMode()}
        number={storeNumber && {
          status: storeNumber.status,
          display: storeNumber.displayNumber ? displayNumber(storeNumber.displayNumber) : `Phone number ID ${storeNumber.phoneNumberId}`,
          coexistence: storeNumber.coexistence,
          failureCode: storeNumber.failureCode,
        }}
      />
    </WhatsAppLinkForm>
  );
}
