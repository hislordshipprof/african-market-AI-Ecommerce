import { platformAdmin } from "@/lib/db";
import { sendSkipped, sendWithTimeout } from "@/lib/inngest/notify";
import { registerStoreWithDoorDash } from "./doordash-registration";
import type { DoorDashOptions } from "./doordash";
import { registerStoreWithUberDirect } from "./uber-direct-registration";
import type { UberDirectOptions } from "./uber-direct";

export const COURIER_REGISTRATION_REQUESTED = "courier/registration.requested";

type Address = { addressLine1: string | null; city: string | null; state: string | null; zip: string | null };

export function hasFullAddress(store: Address): boolean {
  return Boolean(store.addressLine1 && store.city && store.state && store.zip);
}

/**
 * Spec §6.1 step 5: registers the store with Uber Direct and DoorDash Drive. Each provider is registered once; a failure
 * is saved on the store for the admin and the daily retry, and never thrown, so it cannot block onboarding.
 */
export async function registerStoreCouriers(
  storeId: string,
  opts: { uber?: UberDirectOptions; doordash?: DoorDashOptions } = {},
): Promise<void> {
  const store = await platformAdmin.store.findUnique({ where: { id: storeId } });
  if (!store) return;
  await registerStoreWithUberDirect(store, opts.uber);
  if (store.doordashStoreId) return;
  try {
    await registerStoreWithDoorDash(store, opts.doordash);
    await platformAdmin.store.update({ where: { id: storeId }, data: { doordashRegistrationError: null } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "doordash_registration_failed", storeId, error: message }));
    await platformAdmin.store.update({ where: { id: storeId }, data: { doordashRegistrationError: message } });
  }
}

/**
 * Stores with an address and a provider still unregistered: new failures and stores from before #526. Oldest attempt
 * first, since each attempt saves its result on the store, so stores that always fail cannot starve the rest.
 */
export function findStoresNeedingCourierRegistration(limit: number): Promise<Array<{ id: string }>> {
  return platformAdmin.store.findMany({
    where: {
      addressLine1: { not: null },
      city: { not: null },
      state: { not: null },
      zip: { not: null },
      OR: [{ uberLocationId: null }, { doordashStoreId: null }],
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true },
  });
}

/** Queues the registration job. A failed send is logged, never thrown: the daily retry picks the store up. */
export async function requestCourierRegistration(storeId: string): Promise<void> {
  if (sendSkipped()) return;
  try {
    await sendWithTimeout({ name: COURIER_REGISTRATION_REQUESTED, data: { storeId } });
  } catch (err) {
    console.error(JSON.stringify({ event: "inngest_send_failed", name: COURIER_REGISTRATION_REQUESTED, storeId, message: err instanceof Error ? err.message : "send failed" }));
  }
}
