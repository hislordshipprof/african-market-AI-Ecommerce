import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, type Session } from "../auth";
import { getStore, type ValidatedStore } from "../get-store";
import { storeScoped } from "../db";
import { readOnlyStaffIds, storePlan } from "../billing/plan";
import { storeAdminReturnPath, storeSignInPath, storeTwoFactorPath } from "./sign-in-path";

export interface StoreSession {
  user: Session["user"];
  session: Session["session"];
  store: ValidatedStore;
  /** `readOnly`: staff over the plan's limit after a downgrade (ADR-0021). */
  membership: { role: string; readOnly: boolean };
}

export const READ_ONLY_MESSAGE = "Your access is read-only on this store's plan. Ask the owner to upgrade or free a staff seat.";

async function getAuthSession(): Promise<Session | null> {
  const reqHeaders = await headers();
  return auth.api.getSession({
    headers: reqHeaders,
    query: { disableCookieCache: true },
  });
}

/** The signed-in member of this store, or null: no session, 2FA not verified, or not a member. Never redirects. */
export async function storeMember(): Promise<StoreSession | null> {
  const [session, store] = await Promise.all([getAuthSession(), getStore()]);
  // 2FA is optional for store members (#840, ADR-0015), but once on it is never skipped.
  if (!session || (session.user.twoFactorEnabled && !session.session.twoFactorVerified)) return null;

  const scoped = storeScoped(store.id);
  const membership = await scoped.storeMembership.findUnique({
    where: { storeId_userId: { storeId: store.id, userId: session.user.id } },
  });
  if (!membership) return null;

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

export async function requireStoreMember(): Promise<StoreSession> {
  const member = await storeMember();
  if (member) return member;
  const store = await getStore();
  redirect(storeSignInPath(store.slug, (await headers()).get("x-request-path")));
}

export async function requireStoreWriter(): Promise<StoreSession | null> {
  const storeSession = await requireStoreMember();
  return storeSession.membership.readOnly ? null : storeSession;
}

export async function requireStoreOwner(): Promise<StoreSession> {
  const storeSession = await requireStoreMember();

  if (storeSession.membership.role !== "owner") {
    redirect(`/store-admin?store=${storeSession.store.slug}`);
  }

  return storeSession;
}

export const TWO_FACTOR_REQUIRED_MESSAGE =
  "Turn on two-factor sign-in to do this. It keeps your store's money and team safe.";

/** What a gated action returns without 2FA: the message, and a setup link that comes back to this page. */
export type TwoFactorRequired = { error: string; setupHref: string };

export function hasVerifiedTwoFactor(storeSession: Pick<StoreSession, "user" | "session">): boolean {
  return storeSession.user.twoFactorEnabled === true && storeSession.session.twoFactorVerified === true;
}

/**
 * Step-up for money and team actions (#840): null when 2FA is on and verified this session.
 * Call it inside the action, after the role check; hiding a button is not the gate.
 */
export async function twoFactorStepUp(storeSession: StoreSession): Promise<TwoFactorRequired | null> {
  if (hasVerifiedTwoFactor(storeSession)) return null;
  const back = storeAdminReturnPath((await headers()).get("x-request-path"), storeSession.store.slug);
  return { error: TWO_FACTOR_REQUIRED_MESSAGE, setupHref: storeTwoFactorPath(storeSession.store.slug, back) };
}
