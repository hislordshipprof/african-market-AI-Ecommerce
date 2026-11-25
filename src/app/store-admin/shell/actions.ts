"use server";

import { z } from "zod";
import { parseInput } from "@/lib/security/parse-input";
import { requireStoreMember } from "@/lib/store-admin/session";
import { searchStoreAdmin, type AdminSearchResults } from "@/lib/store-admin/search";
import { shellCounts, type ShellCounts } from "./shell-data";

/** The sidebar's counts after a page change: the layout itself is not rendered again on client navigation. */
export async function shellCountsAction(): Promise<ShellCounts> {
  const session = await requireStoreMember();
  return shellCounts(session.store.id);
}

export async function adminSearchAction(query: string): Promise<AdminSearchResults> {
  const session = await requireStoreMember();
  const parsed = parseInput(z.string(), query);
  return searchStoreAdmin(session.store.id, parsed.ok ? parsed.data : "");
}
