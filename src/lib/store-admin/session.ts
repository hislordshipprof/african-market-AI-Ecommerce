import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, type Session } from "../auth";
import { getStore, type ValidatedStore } from "../get-store";
import { storeScoped } from "../db";

export interface StoreSession {
  user: Session["user"];
  session: Session["session"];
  store: ValidatedStore;
  membership: { role: string };
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

  return { user: session.user, session: session.session, store, membership };
}

export async function requireStoreOwner(): Promise<StoreSession> {
  const storeSession = await requireStoreMember();

  if (storeSession.membership.role !== "owner") {
    redirect(`/store-admin?store=${storeSession.store.slug}`);
  }

  return storeSession;
}
