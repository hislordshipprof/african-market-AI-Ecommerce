import { platformAdmin } from "../db";
import { deriveOnboardingStatus } from "./types";
import type { OnboardingStatus } from "./types";

export async function updateStoreOnboardingStatus(
  stripeAccountId: string,
  account: {
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    requirementsCurrentlyDue: string[];
  },
): Promise<{ storeId: string; status: OnboardingStatus } | null> {
  const status = deriveOnboardingStatus(account);

  const stores = await platformAdmin.store.findMany({
    where: { stripeAccountId },
  });

  if (stores.length === 0) return null;

  const store = stores[0];
  await platformAdmin.store.update({
    where: { id: store.id },
    data: { stripeOnboardingStatus: status },
  });

  return { storeId: store.id, status };
}
