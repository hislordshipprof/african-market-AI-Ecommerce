import type { Prisma } from "@prisma/client";

export const SYSTEM_ACTOR_ID = "system_00000000000000000000000";
export const SYSTEM_ACTOR_EMAIL = "system@platform.internal";

/** The one shape for an order audit written by the platform itself. */
export function systemAuditData(
  storeId: string,
  orderId: string,
  action: string,
  after?: Prisma.InputJsonValue,
) {
  return {
    storeId,
    actorId: SYSTEM_ACTOR_ID,
    actorEmail: SYSTEM_ACTOR_EMAIL,
    action,
    entityType: "order" as const,
    entityId: orderId,
    ...(after === undefined ? {} : { after }),
  };
}
