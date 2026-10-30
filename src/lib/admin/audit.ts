import type { Prisma } from "@prisma/client";
import { platformAdmin } from "../db";

interface AuditEntry {
  storeId?: string;
  actorId: string;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
}

export async function writeAuditLog(entry: AuditEntry) {
  return platformAdmin.auditLog.create({
    data: {
      storeId: entry.storeId ?? null,
      actorId: entry.actorId,
      actorEmail: entry.actorEmail,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before ?? undefined,
      after: entry.after ?? undefined,
    },
  });
}
