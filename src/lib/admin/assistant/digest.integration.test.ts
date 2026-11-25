import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { auth } from "../../auth";
import { authPrisma, platformAdmin, platformAdminTransaction } from "../../db";
import { setAdminDigestAction } from "../admin-digest-actions";
import { clearTestSentEmails, getTestSentEmails } from "../../email/send";
import type { AdminBriefing } from "./briefing";
import { runAdminDigest } from "./digest";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t834d-${Date.now()}`;
const NOW = new Date("2026-11-25T12:00:00Z");

const waiting: AdminBriefing = {
  items: [{ key: "refund_failed", count: 2, incomplete: false, label: "2 orders whose refund failed", names: [], href: "/admin/orders", ask: "Which refunds failed?" }],
  unread: [],
};

const setDigest = (on: boolean) => platformAdminTransaction((tx) => tx.platformSettings.update({ where: { id: "platform" }, data: { adminDigestEnabled: on } }));

describe.skipIf(!hasDb)("platform admin daily digest email (#834)", () => {
  const adminEmail = `digest-${RUN}@example.com`;

  beforeEach(async () => {
    clearTestSentEmails();
    await setDigest(true);
    await authPrisma.user.upsert({
      where: { email: adminEmail },
      create: { id: crypto.randomUUID(), email: adminEmail, name: "Digest admin", emailVerified: true, role: "platform_admin" },
      update: {},
    });
  });

  afterAll(async () => {
    await setDigest(true);
    await platformAdminTransaction((tx) => tx.auditLog.deleteMany({ where: { actorEmail: adminEmail } }));
    await authPrisma.user.deleteMany({ where: { email: adminEmail } });
  });

  it("emails every platform admin the briefing's list with a link to each next step", async () => {
    expect(await runAdminDigest(NOW, async () => waiting)).toBe("sent");
    const mine = getTestSentEmails().filter((email) => email.to === adminEmail);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.html).toContain("2 orders whose refund failed");
    expect(mine[0]!.html).toContain("/admin/orders");
    expect(mine[0]!.idempotencyKey).toContain("2026-11-25");
  });

  it("sends no email on a day with nothing waiting", async () => {
    expect(await runAdminDigest(NOW, async () => ({ items: [], unread: [] }))).toBe("nothing_waiting");
    expect(getTestSentEmails()).toHaveLength(0);
  });

  it("sends nothing when an admin switched the digest off in settings, and the switch is audited", async () => {
    const admin = await authPrisma.user.findFirstOrThrow({ where: { email: adminEmail } });
    vi.spyOn(auth.api, "getSession").mockResolvedValue({
      user: { id: admin.id, email: admin.email, role: "platform_admin", twoFactorEnabled: true },
      session: { twoFactorVerified: true },
    } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>);
    await setAdminDigestAction(new FormData());
    vi.restoreAllMocks();
    expect(await platformAdmin.auditLog.count({ where: { actorId: admin.id, action: "platform.admin_digest_update" } })).toBe(1);
    expect(await runAdminDigest(NOW, async () => waiting)).toBe("off");
    expect(getTestSentEmails()).toHaveLength(0);
  });
});
