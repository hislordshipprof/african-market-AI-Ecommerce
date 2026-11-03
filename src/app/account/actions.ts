"use server";

import { syncCustomerForRequest } from "@/lib/customer-sync";

export async function syncCustomerAction(): Promise<{ ok: boolean }> {
  const customer = await syncCustomerForRequest();
  return { ok: customer !== null };
}
