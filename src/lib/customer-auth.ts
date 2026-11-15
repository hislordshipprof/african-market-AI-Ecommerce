import { storeScoped } from "./db";
import { Prisma } from "@prisma/client";

export interface StoreCustomer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

function toStoreCustomer(row: StoreCustomer): StoreCustomer {
  return { id: row.id, name: row.name, email: row.email, phone: row.phone };
}

// The re-read after a unique violation needs its own transaction: Postgres aborts the failed one (25P02).
export async function findOrCreateCustomer(
  storeId: string,
  user: { id: string; name: string; email: string },
): Promise<StoreCustomer> {
  const db = storeScoped(storeId);

  const existing = await db.customer.findFirst({
    where: { userId: user.id },
  });

  if (existing) {
    // A magic-link sign-up starts with an empty name; fill it once the account has one.
    if (!existing.name.trim() && user.name.trim()) {
      const named = await db.customer.update({
        where: { id: existing.id },
        data: { name: user.name.trim() },
      });
      return toStoreCustomer(named);
    }
    return toStoreCustomer(existing);
  }

  try {
    const created = await db.customer.create({
      data: {
        storeId,
        userId: user.id,
        name: user.name,
        email: user.email,
        phone: null,
      },
    });
    return toStoreCustomer(created);
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      const raced = await db.customer.findFirst({
        where: { userId: user.id },
      });
      if (raced) return toStoreCustomer(raced);
    }
    throw e;
  }
}
