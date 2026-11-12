import type { Store } from "@prisma/client";
import { platformAdmin } from "@/lib/db";
import { createDoorDashClient, doordashAddress, type DoorDashOptions, type DoorDashRequest } from "./doordash";
import { DeliveryProviderError } from "./provider";

type RegistrableStore = Pick<Store, "id" | "name" | "addressLine1" | "addressLine2" | "city" | "state" | "zip" | "doordashStoreId">;

async function exists(request: DoorDashRequest, path: string): Promise<boolean> {
  try {
    await request("GET", path);
    return true;
  } catch (error) {
    if (error instanceof DeliveryProviderError && error.status === 404) return false;
    throw error;
  }
}

/**
 * Registers the store with DoorDash Drive as its own business and store (spec §6.1 step 5), keyed by our store id,
 * and saves the external_store_id. Each step checks first, so a retry after a partial run finishes it.
 * Business and store endpoints: https://developer.doordash.com/en-US/api/drive/ (Business & Store).
 */
export async function registerStoreWithDoorDash(store: RegistrableStore, opts: DoorDashOptions = {}): Promise<string> {
  if (store.doordashStoreId) return store.doordashStoreId;
  const { addressLine1, city, state, zip } = store;
  if (!addressLine1 || !city || !state || !zip) {
    throw new Error("The store needs a full address before it can be registered with DoorDash");
  }
  const request = createDoorDashClient(opts);
  const businessId = store.id;
  const storeId = store.id;

  if (!(await exists(request, `/developer/v1/businesses/${businessId}`))) {
    await request("POST", "/developer/v1/businesses", { external_business_id: businessId, name: store.name });
  }
  if (!(await exists(request, `/developer/v1/businesses/${businessId}/stores/${storeId}`))) {
    await request("POST", `/developer/v1/businesses/${businessId}/stores`, {
      external_store_id: storeId,
      name: store.name,
      address: doordashAddress({ line1: addressLine1, line2: store.addressLine2, city, state, zip }),
    });
  }
  await platformAdmin.store.update({ where: { id: store.id }, data: { doordashStoreId: storeId } });
  return storeId;
}
