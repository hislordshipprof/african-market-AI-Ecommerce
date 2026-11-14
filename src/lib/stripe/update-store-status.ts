import { platformAdmin } from "../db";
import { revalidateStore } from "../get-store";
import { getStripeProvider } from "./index";
import { deriveOnboardingStatus } from "./types";
import type { OnboardingStatus } from "./types";

export async function updateStoreOnboardingStatus(
  stripeAccountId: string,
): Promise<{ storeId: string; status: OnboardingStatus } | null> {
  const stores = await platformAdmin.store.findMany({
    where: { stripeAccountId },
  });

  if (stores.length === 0) return null;

  const store = stores[0];

  const provider = getStripeProvider();
  const account = await provider.getAccount(stripeAccountId);
  const status = deriveOnboardingStatus(account);

  if (store.stripeOnboardingStatus === status) {
    return { storeId: store.id, status };
  }

  await platformAdmin.store.update({
    where: { id: store.id },
    data: { stripeOnboardingStatus: status },
  });

  revalidateStore(store);

  return { storeId: store.id, status };
}
