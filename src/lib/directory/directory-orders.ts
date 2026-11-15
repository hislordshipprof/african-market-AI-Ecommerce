import { storeScoped } from "../db";
import { DIRECTORY_REF } from "./attribution";

/** Orders the Store directory sent this store (#454), for the store dashboard. */
export async function directoryOrderCount(storeId: string): Promise<number> {
  return storeScoped(storeId).order.count({ where: { storeId, acquisitionSource: DIRECTORY_REF } });
}
