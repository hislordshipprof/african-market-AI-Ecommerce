import { storeScoped } from "./db";
import type { Session } from "./auth";
import { Prisma } from "@prisma/client";

const PLACEHOLDER_DOMAIN = "@phone.placeholder.local";

function cleanEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  if (email.endsWith(PLACEHOLDER_DOMAIN)) return null;
  return email;
}

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
  const db = storeScoped(storeId);

  const existing = await db.customer.findFirst({
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
    const created = await db.customer.create({
      data: {
        storeId,
        userId: user.id,
        name: user.name,
        email: cleanEmail(user.email),
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
      const raced = await db.customer.findFirst({
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
}
