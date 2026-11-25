import { platformAdmin, platformAdminTransaction } from "../db";
import { requestCourierRegistration } from "../delivery/courier-registration";

/**
 * Queues the courier registration job again for one store (#526), after an audit row naming the admin. The store
 * page's retry button and the admin assistant's confirm both call this. The caller checks the platform admin.
 */
export async function retryCourierRegistration(storeId: string, actor: { id: string; email: string }): Promise<"queued" | "failed" | "missing"> {
  const store = await platformAdmin.store.findUnique({ where: { id: storeId }, select: { id: true } });
  if (!store) return "missing";
  await platformAdminTransaction((tx) =>
    tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "store.courier_registration_retry",
        entityType: "store",
        entityId: storeId,
      },
    }),
  );
  return (await requestCourierRegistration(storeId)) ? "queued" : "failed";
}
