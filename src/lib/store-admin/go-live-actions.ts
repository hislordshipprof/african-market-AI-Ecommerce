"use server";

import { revalidatePath } from "next/cache";
import { requireStoreOwner } from "./session";
import { goLive, type GoLiveResult } from "../go-live/service";

/** Owner only. The store is the session's; the input never names one. The checklist is read again on the server. */
export async function goLiveAction(): Promise<GoLiveResult> {
  const session = await requireStoreOwner();
  const result = await goLive(session.store.id, { id: session.user.id, email: session.user.email }, new Date());
  if (result.ok) revalidatePath("/store-admin");
  return result;
}
