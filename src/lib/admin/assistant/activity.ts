import { authPrisma, platformAdminTransaction } from "../../db";
import { requirePlatformAdmin } from "../session";

/** The audit rows the assistant writes, and what the activity view calls each. */
const ACTIONS: Record<string, string> = {
  "admin_assistant.tool": "Tool call",
  "admin_assistant.draft_proposed": "Card drafted",
  "admin_assistant.draft_confirmed": "Confirmed",
  "admin_assistant.draft_rejected": "Rejected",
  "admin_assistant.draft_stale": "Stale",
  "admin_assistant.draft_refused": "Refused",
};
export const ACTIVITY_PAGE = 100;
const DETAIL_MAX = 300;

export interface ActivityRow {
  id: string;
  at: Date;
  adminEmail: string;
  what: string;
  /** The tool or the card's kind. */
  name: string;
  /** The parameters, a typed reason included, as stored. */
  detail: string;
}

function detailOf(after: unknown): { name: string; detail: string } {
  const value = (after && typeof after === "object" ? after : {}) as Record<string, unknown>;
  const name = typeof value.tool === "string" ? value.tool : typeof value.kind === "string" ? value.kind : "";
  const params = value.params ?? value.reason ?? null;
  const text = params === null ? "" : JSON.stringify(params);
  return { name, detail: text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text };
}

/** The assistant's audit rows, newest first, optionally for one admin and before a time (the next page). */
export async function listAssistantActivity(filter: { adminId?: string; before?: Date }): Promise<{ rows: ActivityRow[]; more: boolean; admins: Array<{ id: string; email: string }> }> {
  await requirePlatformAdmin();
  const [found, admins] = await Promise.all([
    platformAdminTransaction((tx) => tx.auditLog.findMany({
      where: {
        action: { in: Object.keys(ACTIONS) },
        ...(filter.adminId ? { actorId: filter.adminId } : {}),
        ...(filter.before ? { createdAt: { lt: filter.before } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ACTIVITY_PAGE + 1,
      select: { id: true, createdAt: true, actorEmail: true, action: true, after: true },
    })),
    authPrisma.user.findMany({ where: { role: "platform_admin" }, select: { id: true, email: true }, orderBy: { email: "asc" } }),
  ]);
  return {
    more: found.length > ACTIVITY_PAGE,
    admins,
    rows: found.slice(0, ACTIVITY_PAGE).map((row) => ({
      id: row.id,
      at: row.createdAt,
      adminEmail: row.actorEmail,
      what: ACTIONS[row.action] ?? row.action,
      ...detailOf(row.after),
    })),
  };
}
