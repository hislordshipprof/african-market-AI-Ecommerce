import { storeScoped } from "./db";
import type { Session } from "./auth";

export interface CustomerProfile {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

export async function findOrCreateCustomer(
  storeId: string,
  user: Session["user"],
): Promise<CustomerProfile> {
  const scoped = storeScoped(storeId);

  const existing = await scoped.customer.findFirst({
    where: { userId: user.id },
  });

  if (existing) {
    return {
      id: existing.id,
      name: existing.name,
      email: existing.email,
      phone: existing.phone,
    };
  }

  const created = await scoped.customer.create({
    data: {
      storeId,
      userId: user.id,
      name: user.name,
      email: user.email || null,
      phone: (user as Record<string, unknown>).phone as string | undefined ?? null,
    },
  });

  return {
    id: created.id,
    name: created.name,
    email: created.email,
    phone: created.phone,
  };
}
