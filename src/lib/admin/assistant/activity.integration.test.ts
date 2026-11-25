import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { auth } from "../../auth";
import { authPrisma, platformAdminTransaction } from "../../db";
import { listAssistantActivity } from "./activity";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t834a-${Date.now()}`;

describe.skipIf(!hasDb)("admin assistant activity (#834)", () => {
  const ada = { id: crypto.randomUUID(), email: `ada-${RUN}@example.com` };
  const ben = { id: crypto.randomUUID(), email: `ben-${RUN}@example.com` };

  beforeAll(async () => {
    for (const user of [ada, ben]) {
      await authPrisma.user.create({ data: { ...user, name: "Admin", emailVerified: true, role: "platform_admin" } });
    }
    vi.spyOn(auth.api, "getSession").mockResolvedValue({
      user: { ...ada, role: "platform_admin", twoFactorEnabled: true },
      session: { twoFactorVerified: true },
    } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>);
    const row = (actor: typeof ada, action: string, minutesAgo: number, after: object) => ({
      actorId: actor.id, actorEmail: actor.email, action, entityType: "admin_assistant_draft", entityId: RUN, after, createdAt: new Date(Date.now() - minutesAgo * 60_000),
    });
    await platformAdminTransaction((tx) => tx.auditLog.createMany({
      data: [
        row(ada, "admin_assistant.tool", 30, { tool: "find_stores", params: { query: "palm" } }),
        row(ada, "admin_assistant.draft_confirmed", 10, { kind: "platform_refund", params: { reason: "Wrong yams" } }),
        row(ben, "admin_assistant.draft_rejected", 20, { kind: "store_status" }),
        row(ada, "store.suspend", 5, {}),
      ],
    }));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await platformAdminTransaction((tx) => tx.auditLog.deleteMany({ where: { entityId: RUN } }));
    await authPrisma.user.deleteMany({ where: { id: { in: [ada.id, ben.id] } } });
  });

  it("lists the assistant's tool calls, confirms and rejects newest first, and not other audit rows", async () => {
    const { rows } = await listAssistantActivity({ adminId: ada.id });
    expect(rows.map((row) => row.what)).toEqual(["Confirmed", "Tool call"]);
    expect(rows[0]).toMatchObject({ name: "platform_refund", detail: expect.stringContaining("Wrong yams") });
  });

  it("filters by admin, and offers each admin in the filter", async () => {
    const { rows, admins } = await listAssistantActivity({ adminId: ben.id });
    expect(rows.map((row) => row.adminEmail)).toEqual([ben.email]);
    expect(admins.map((admin) => admin.email)).toEqual(expect.arrayContaining([ada.email, ben.email]));
  });
});
