import { platformAdminTransaction } from "../db";
import { revalidateStore } from "../get-store";
import { queueStoreRequestNotices } from "../directory/store-requests";
import { goLiveItemLabel, readGoLiveChecklist, type GoLiveChecklist } from "./checklist";

export type GoLiveResult = { ok: true } | { ok: false; error: string };

interface Actor {
  id: string;
  email: string;
}

export const FORCE_REASON_MAX = 500;

/**
 * Moves a store from `setup` to `active` with one audit row. The update is conditional on `setup`, so a second click,
 * a second tab or a suspension that lands first changes nothing. `list` also lists it in the directory (#784).
 */
async function markLive(
  storeId: string,
  actor: Actor,
  action: "store.go_live" | "store.go_live_forced",
  after: Record<string, unknown>,
  list: boolean,
): Promise<void> {
  const store = await platformAdminTransaction(async (tx) => {
    const prior = await tx.store.findUnique({ where: { id: storeId }, select: { listed: true } });
    const data = list ? { status: "active", listed: true } : { status: "active" };
    const moved = await tx.store.updateMany({ where: { id: storeId, status: "setup" }, data });
    if (moved.count === 0 || !prior) return null;
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action,
        entityType: "store",
        entityId: storeId,
        before: { status: "setup", listed: prior.listed },
        after: { ...data, ...after },
      },
    });
    return tx.store.findUniqueOrThrow({ where: { id: storeId }, select: { id: true, slug: true, customDomain: true, listed: true } });
  });
  if (!store) return;
  revalidateStore(store);
  // The directory lists the store from now on, so a waiting "tell me when a store opens" request may match it (#455).
  if (store.listed) await queueStoreRequestNotices(store.id);
}

function openKeys(checklist: GoLiveChecklist): string[] {
  return checklist.items.filter((i) => !i.done).map((i) => i.key);
}

/** The owner's Go live: refused unless every checklist item is done, and lists the store. Suspended wins over everything. */
export async function goLive(storeId: string, actor: Actor, now: Date): Promise<GoLiveResult> {
  const checklist = await readGoLiveChecklist(storeId, now);
  if (!checklist) return { ok: false, error: "Store not found." };
  const status = checklist.status;
  if (status === "suspended") return { ok: false, error: "This store is suspended. The platform team must lift the suspension first." };
  if (status === "active") return { ok: true };
  if (!checklist.ready) {
    const open = checklist.items.filter((i) => !i.done).map((i) => goLiveItemLabel(i.key, checklist.floor));
    return { ok: false, error: `Finish the checklist first: ${open.join(", ")}.` };
  }
  await markLive(storeId, actor, "store.go_live", {}, true);
  return { ok: true };
}

/** A platform admin's go live with items still open: needs a reason, which the audit row keeps with the open items. */
export async function forceGoLive(storeId: string, rawReason: string, actor: Actor, now: Date): Promise<GoLiveResult> {
  const reason = rawReason.trim();
  if (!reason) return { ok: false, error: "Give a reason for going live with items open." };
  if (reason.length > FORCE_REASON_MAX) return { ok: false, error: `Keep the reason to ${FORCE_REASON_MAX} characters.` };
  const checklist = await readGoLiveChecklist(storeId, now);
  if (!checklist) return { ok: false, error: "Store not found." };
  if (checklist.status === "suspended") return { ok: false, error: "This store is suspended. Lift the suspension first." };
  if (checklist.status === "active") return { ok: true };
  await markLive(storeId, actor, "store.go_live_forced", { reason, openItems: openKeys(checklist) }, false);
  return { ok: true };
}
