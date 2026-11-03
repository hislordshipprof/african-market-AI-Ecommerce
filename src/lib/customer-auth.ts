import { storeScopedTransaction } from "./db";
import type { Session } from "./auth";
import { Prisma } from "@prisma/client";

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
  return storeScopedTransaction(storeId, async (tx) => {
    const existing = await tx.customer.findFirst({
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

    try {
      const created = await tx.customer.create({
        data: {
          storeId,
          userId: user.id,
          name: user.name,
          email: user.email || null,
          phone:
            (user as Record<string, unknown>).phoneNumber as
              | string
              | undefined ?? null,
        },
      });

      return {
        id: created.id,
        name: created.name,
        email: created.email,
        phone: created.phone,
      };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        const raced = await tx.customer.findFirst({
          where: { userId: user.id },
        });
        if (raced) {
          return {
            id: raced.id,
            name: raced.name,
            email: raced.email,
            phone: raced.phone,
          };
        }
      }
      throw e;
    }
  });
}
