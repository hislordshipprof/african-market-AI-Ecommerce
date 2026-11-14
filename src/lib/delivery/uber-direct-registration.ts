import type { Store } from "@prisma/client";
import { platformAdmin } from "@/lib/db";
import { createUberDirectClient, type UberDirectOptions } from "./uber-direct";

type RegistrableStore = Pick<Store, "id" | "name" | "addressLine1" | "addressLine2" | "city" | "state" | "zip" | "uberLocationId">;

export type UberRegistrationResult = { ok: true; uberLocationId: string } | { ok: false; error: string };

/**
 * Registers the store with Uber Direct as a sub-organization of the platform's account (spec §6.1 step 5) and saves
 * its organization_id as uberLocationId. Centralized billing: Uber bills the platform, which charges the courier fee
 * at cost (ADR-0021); the sandbox refuses decentralized billing under our account. On failure the error is logged and
 * saved on the store, which flags it for a retry. Uber does not key organizations on our id, so a retry after a
 * create whose save failed makes a second organization.
 * Organizations API (scope direct.organizations): https://developer.uber.com/docs/deliveries/api-reference/org;
 * body and response shapes were confirmed against the Uber Direct sandbox on 2026-11-13.
 */
export async function registerStoreWithUberDirect(store: RegistrableStore, opts: UberDirectOptions = {}): Promise<UberRegistrationResult> {
  if (store.uberLocationId) return { ok: true, uberLocationId: store.uberLocationId };
  try {
    const { addressLine1, city, state, zip } = store;
    if (!addressLine1 || !city || !state || !zip) {
      throw new Error("The store needs a full address before it can be registered with Uber Direct");
    }
    const client = createUberDirectClient(opts);
    const res = await client.request("direct.organizations", "POST", "/v1/direct/organizations", {
      info: {
        name: store.name,
        billing_type: "BILLING_TYPE_CENTRALIZED",
        address: { street1: addressLine1, street2: store.addressLine2 ?? "", city, state, zipcode: zip, country_iso2: "US" },
      },
      hierarchy_info: { parent_organization_id: client.customerId() },
    });
    if (typeof res.organization_id !== "string" || !res.organization_id) {
      throw new Error("Uber Direct returned an organization without an organization_id");
    }
    await platformAdmin.store.update({
      where: { id: store.id },
      data: { uberLocationId: res.organization_id, uberRegistrationError: null },
    });
    return { ok: true, uberLocationId: res.organization_id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "uber_direct_registration_failed", storeId: store.id, error: message }));
    await platformAdmin.store.update({ where: { id: store.id }, data: { uberRegistrationError: message } });
    return { ok: false, error: message };
  }
}
