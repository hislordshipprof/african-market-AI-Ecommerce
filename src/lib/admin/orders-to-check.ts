"use server";

import { requirePlatformAdmin } from "./session";
import { findOrdersToCheck } from "./orders-to-check-query";

export async function listOrdersToCheck() {
  await requirePlatformAdmin();
  return findOrdersToCheck();
}
