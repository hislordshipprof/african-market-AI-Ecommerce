import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, type Session } from "../auth";
import { getStore, type ValidatedStore } from "../get-store";
import { storeScoped } from "../db";
import { readOnlyStaffIds, storePlan } from "../billing/plan";

export interface StoreSession {
  user: Session["user"];
  session: Session["session"];
  store: ValidatedStore;
  /** `readOnly`: staff over the plan's limit after a downgrade (ADR-0021). */
  membership: { role: string; readOnly: boolean };
}

export const READ_ONLY_MESSAGE = "Your access is read-only on this store's plan. Ask the owner to upgrade or free a staff seat.";

export class ReadOnlyStaffError extends Error {
  constructor() {
    super(READ_ONLY_MESSAGE);
    this.name = "ReadOnlyStaffError";
  }
}

async function getAuthSession(): Promise<Session | null> {
  const reqHeaders = await headers();
  return auth.api.getSession({
    headers: reqHeaders,
    query: { disableCookieCache: true },
  });
}

export async function requireStoreMember(): Promise<StoreSession> {
  const [session, store] = await Promise.all([getAuthSession(), getStore()]);

  if (!session) {
    redirect(`/store-admin/sign-in?store=${store.slug}`);
  }

  if (!session.user.twoFactorEnabled || !session.session.twoFactorVerified) {
    redirect(`/store-admin/sign-in?store=${store.slug}`);
  }

  const scoped = storeScoped(store.id);
  const membership = await scoped.storeMembership.findUnique({
    where: { storeId_userId: { storeId: store.id, userId: session.user.id } },
  });

  if (!membership) {
    redirect(`/store-admin/sign-in?store=${store.slug}`);
  }

  let readOnly = false;
  if (membership.role !== "owner") {
    const [plan, members] = await Promise.all([
      storePlan(store.id),
      scoped.storeMembership.findMany({ select: { userId: true, role: true, createdAt: true } }),
    ]);
    readOnly = readOnlyStaffIds(plan, members).has(session.user.id);
  }

  return { user: session.user, session: session.session, store, membership: { role: membership.role, readOnly } };
}

/** A member allowed to change things: read-only staff are refused. */
export async function requireStoreWriter(): Promise<StoreSession> {
  const storeSession = await requireStoreMember();
  if (storeSession.membership.readOnly) throw new ReadOnlyStaffError();
  return storeSession;
}

export async function requireStoreOwner(): Promise<StoreSession> {
  const storeSession = await requireStoreMember();

  if (storeSession.membership.role !== "owner") {
    redirect(`/store-admin?store=${storeSession.store.slug}`);
  }

  return storeSession;
}
