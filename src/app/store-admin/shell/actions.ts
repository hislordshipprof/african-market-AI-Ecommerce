"use server";

import { z } from "zod";
import { parseInput } from "@/lib/security/parse-input";
import { requireStoreMember, storeMember } from "@/lib/store-admin/session";
import { searchStoreAdmin, type AdminSearchResults } from "@/lib/store-admin/search";
import { shellCounts, type ShellCounts } from "./shell-data";

/**
 * The sidebar's counts after a page change: the layout itself is not rendered again on client navigation.
 * Null when no member is signed in: a background fetch must never redirect, or it drops sign-in's `next` (#797).
 */
export async function shellCountsAction(): Promise<ShellCounts | null> {
  const session = await storeMember();
  return session ? shellCounts(session.store.id) : null;
}

export async function adminSearchAction(query: string): Promise<AdminSearchResults> {
  const session = await requireStoreMember();
  const parsed = parseInput(z.string(), query);
  return searchStoreAdmin(session.store.id, parsed.ok ? parsed.data : "");
}
