import { Prisma } from "@prisma/client";
import { storeScoped } from "./db";
import { findOrCreateCustomer, type StoreCustomer } from "./customer-auth";
import { isPrivilegedUser } from "./privileged-user";

/** The fields of Better Auth's session user that the account sync needs. */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
}

/**
 * Link this store's guest Customer rows placed with the account's verified email to the
 * account Customer (Claimed order). One conditional statement, so a repeat run, a second
 * tab or a concurrent run links each row once and never rewrites `claimedAt`. Orders and
 * the guest row's contact details are never written.
 */
export async function claimGuestOrders(
  storeId: string,
  accountCustomerId: string,
  user: Pick<SessionUser, "id" | "email" | "emailVerified">,
): Promise<{ claimed: number }> {
  // Only a proven mailbox may claim: /sign-up/email creates users with someone else's email.
  if (user.emailVerified !== true) return { claimed: 0 };
  const email = user.email.trim().toLowerCase();
  if (!email) return { claimed: 0 };
  if (await isPrivilegedUser(user.id)) return { claimed: 0 };

  const result = await storeScoped(storeId).customer.updateMany({
    where: {
      storeId,
      userId: null,
      claimedByCustomerId: null,
      email,
      id: { not: accountCustomerId },
    },
    data: { claimedByCustomerId: accountCustomerId, claimedAt: new Date() },
  });
  return { claimed: result.count };
}

function errorCode(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : "unknown";
}

/**
 * Resolve the account Customer for this store, then claim matching guest orders.
 * A failed claim is logged (store id and error code only, never the email or message)
 * and retried on the next visit; the account still resolves.
 */
export async function syncCustomerForStore(
  storeId: string,
  user: SessionUser,
): Promise<StoreCustomer> {
  const customer = await findOrCreateCustomer(storeId, user);
  try {
    const { claimed } = await claimGuestOrders(storeId, customer.id, user);
    if (claimed > 0) {
      console.info(JSON.stringify({ event: "guest_orders_claimed", storeId, claimed }));
    }
  } catch (error) {
    console.error(
      JSON.stringify({ event: "guest_order_claim_failed", storeId, code: errorCode(error) }),
    );
  }
  return customer;
}
