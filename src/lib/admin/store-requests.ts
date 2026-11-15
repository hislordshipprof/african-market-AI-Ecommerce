import { requestsByArea, type RequestArea } from "../directory/store-requests";
import { requirePlatformAdmin } from "./session";

/** Platform admin only: "tell me when a store opens" requests by state and ZIP, counts only (#455). */
export async function listStoreRequestAreas(): Promise<RequestArea[]> {
  await requirePlatformAdmin();
  return requestsByArea();
}
