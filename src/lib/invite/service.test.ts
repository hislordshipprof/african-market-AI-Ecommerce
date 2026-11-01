import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped, platformAdmin } from "../db";
import {
  createInvite,
  validateInviteToken,
  acceptInvite,
  removeStoreMember,
  _hashTokenForTesting,
} from "./service";
import { clearTestSentEmails, getTestSentEmails } from "../email/send";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Invite service", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;
  let inviterUserId: string;
  let inviteeUserId: string;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const storeA = await rawPrisma.store.upsert({
      where: { slug: "invite-svc-a" },
      update: {},
      create: { slug: "invite-svc-a", name: "Invite Svc Store A", themePreset: "palm-and-shea" },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.upsert({
      where: { slug: "invite-svc-b" },
      update: {},
      create: { slug: "invite-svc-b", name: "Invite Svc Store B", themePreset: "lagoon-and-coral" },
    });
    storeBId = storeB.id;

    const inviter = await rawPrisma.user.upsert({
      where: { email: "invite-svc-inviter@example.com" },
      update: {},
      create: { id: "invite-svc-inviter", email: "invite-svc-inviter@example.com", name: "Inviter", emailVerified: true },
    });
    inviterUserId = inviter.id;

    const invitee = await rawPrisma.user.upsert({
      where: { email: "invite-svc-invitee@example.com" },
      update: {},
      create: { id: "invite-svc-invitee", email: "invite-svc-invitee@example.com", name: "Invitee", emailVerified: true },
    });
    inviteeUserId = invitee.id;
  });

  beforeEach(async () => {
    clearTestSentEmails();
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.auditLog.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.storeInvite.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.storeMembership.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
  });

  afterAll(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.auditLog.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.storeInvite.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.storeMembership.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
    await rawPrisma.user.deleteMany({
      where: { email: { in: ["invite-svc-inviter@example.com", "invite-svc-invitee@example.com"] } },
    });
    await rawPrisma.store.deleteMany({
      where: { slug: { in: ["invite-svc-a", "invite-svc-b"] } },
    });
    await rawPrisma.$disconnect();
  });

  function baseInput(overrides: Partial<Parameters<typeof createInvite>[0]> = {}) {
    return {
      storeId: storeAId,
      email: "new-staff@example.com",
      role: "staff" as const,
      invitedById: inviterUserId,
      actorEmail: "invite-svc-inviter@example.com",
      baseUrl: "http://localhost:3000",
      storeSlug: "invite-svc-a",
      storeName: "Invite Svc Store A",
      ...overrides,
    };
  }

  describe("createInvite", () => {
    it("creates invite with valid token, correct fields", async () => {
      const result = await createInvite(baseInput());

      expect(result.id).toBeTruthy();
      expect(result.tokenHash).toBeTruthy();

      const invite = await platformAdmin.storeInvite.findUnique({
        where: { id: result.id },
      });
      expect(invite).not.toBeNull();
      expect(invite!.storeId).toBe(storeAId);
      expect(invite!.email).toBe("new-staff@example.com");
      expect(invite!.role).toBe("staff");
      expect(invite!.tokenHash).toBe(result.tokenHash);
      expect(invite!.usedAt).toBeNull();

      const expectedExpiry = Date.now() + 72 * 60 * 60 * 1000;
      expect(invite!.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(invite!.expiresAt.getTime()).toBeLessThanOrEqual(expectedExpiry + 5000);
    });

    it("sends invite email", async () => {
      await createInvite(baseInput());

      const emails = getTestSentEmails();
      expect(emails).toHaveLength(1);
      expect(emails[0].to).toBe("new-staff@example.com");
      expect(emails[0].subject).toContain("Invite Svc Store A");
      expect(emails[0].html).toContain("invite-svc-a");
    });

    it("dedup: marks old invite used and creates new one", async () => {
      const first = await createInvite(baseInput());
      const second = await createInvite(baseInput());

      expect(first.id).not.toBe(second.id);
      expect(first.tokenHash).not.toBe(second.tokenHash);

      const oldInvite = await platformAdmin.storeInvite.findUnique({
        where: { id: first.id },
      });
      expect(oldInvite!.usedAt).not.toBeNull();

      const newInvite = await platformAdmin.storeInvite.findUnique({
        where: { id: second.id },
      });
      expect(newInvite!.usedAt).toBeNull();
    });

    it("writes auditLog entry with action invite.create", async () => {
      const result = await createInvite(baseInput());

      const logs = await platformAdmin.auditLog.findMany({
        where: { storeId: storeAId, action: "invite.create" },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].actorId).toBe(inviterUserId);
      expect(logs[0].actorEmail).toBe("invite-svc-inviter@example.com");
      expect(logs[0].entityType).toBe("store_invite");
      expect(logs[0].entityId).toBe(result.id);
      expect(logs[0].after).toEqual({ email: "new-staff@example.com", role: "staff" });
    });

    it("rejects when user is already a member", async () => {
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.storeMembership.create({
          data: { storeId: storeAId, userId: inviteeUserId, role: "staff" },
        }),
      ]);

      await expect(
        createInvite(baseInput({ email: "invite-svc-invitee@example.com" })),
      ).rejects.toThrow("User is already a member of this store");
    });

    it("normalizes email to lowercase", async () => {
      const result = await createInvite(baseInput({ email: "Upper.Case@Example.COM" }));

      const invite = await platformAdmin.storeInvite.findUnique({
        where: { id: result.id },
      });
      expect(invite!.email).toBe("upper.case@example.com");
    });
  });

  describe("validateInviteToken", () => {
    it("returns invite data for valid token", async () => {
      const rawToken = "test-valid-token-" + Date.now();
      const tokenHash = _hashTokenForTesting(rawToken);

      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.storeInvite.create({
          data: {
            storeId: storeAId,
            email: "validate-test@example.com",
            role: "staff",
            tokenHash,
            expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
            invitedById: inviterUserId,
          },
        }),
      ]);

      const result = await validateInviteToken(rawToken);

      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.storeId).toBe(storeAId);
        expect(result.email).toBe("validate-test@example.com");
        expect(result.role).toBe("staff");
        expect(result.storeName).toBe("Invite Svc Store A");
        expect(result.storeSlug).toBe("invite-svc-a");
      }
    });

    it("returns error for expired token", async () => {
      const rawToken = "test-expired-token-" + Date.now();
      const tokenHash = _hashTokenForTesting(rawToken);

      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.storeInvite.create({
          data: {
            storeId: storeAId,
            email: "expired-test@example.com",
            role: "staff",
            tokenHash,
            expiresAt: new Date(Date.now() - 1000),
            invitedById: inviterUserId,
          },
        }),
      ]);

      const result = await validateInviteToken(rawToken);

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("expired");
      }
    });

    it("returns error for invalid token", async () => {
      const result = await validateInviteToken("completely-invalid-token");
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("Invalid");
      }
    });

    it("returns error for already-used token", async () => {
      const rawToken = "test-used-token-" + Date.now();
      const tokenHash = _hashTokenForTesting(rawToken);

      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.storeInvite.create({
          data: {
            storeId: storeAId,
            email: "used-test@example.com",
            role: "staff",
            tokenHash,
            expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
            usedAt: new Date(),
            invitedById: inviterUserId,
          },
        }),
      ]);

      const result = await validateInviteToken(rawToken);

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("already been used");
      }
    });
  });

  describe("acceptInvite", () => {
    it("creates membership, marks invite used, writes audit log", async () => {
      const rawToken = "test-accept-token-" + Date.now();
      const tokenHash = _hashTokenForTesting(rawToken);

      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.storeInvite.create({
          data: {
            storeId: storeAId,
            email: "invite-svc-invitee@example.com",
            role: "staff",
            tokenHash,
            expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
            invitedById: inviterUserId,
          },
        }),
      ]);

      const result = await acceptInvite(rawToken, inviteeUserId, "invite-svc-invitee@example.com");

      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.storeId).toBe(storeAId);
        expect(result.role).toBe("staff");
        expect(result.storeSlug).toBe("invite-svc-a");
      }

      const membership = await platformAdmin.storeMembership.findUnique({
        where: { storeId_userId: { storeId: storeAId, userId: inviteeUserId } },
      });
      expect(membership).not.toBeNull();
      expect(membership!.role).toBe("staff");

      const invite = await platformAdmin.storeInvite.findUnique({
        where: { tokenHash },
      });
      expect(invite!.usedAt).not.toBeNull();

      const logs = await platformAdmin.auditLog.findMany({
        where: { storeId: storeAId, action: "membership.create" },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].actorId).toBe(inviteeUserId);
      expect(logs[0].entityType).toBe("store_membership");
    });

    it("rejects on email mismatch", async () => {
      const rawToken = "test-mismatch-token-" + Date.now();
      const tokenHash = _hashTokenForTesting(rawToken);

      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.storeInvite.create({
          data: {
            storeId: storeAId,
            email: "intended@example.com",
            role: "staff",
            tokenHash,
            expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
            invitedById: inviterUserId,
          },
        }),
      ]);

      const result = await acceptInvite(rawToken, inviteeUserId, "wrong-email@example.com");

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("different email");
      }

      const membership = await platformAdmin.storeMembership.findFirst({
        where: { storeId: storeAId, userId: inviteeUserId },
      });
      expect(membership).toBeNull();
    });

    it("handles already-member gracefully (marks invite used, returns existing role)", async () => {
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.storeMembership.create({
          data: { storeId: storeAId, userId: inviteeUserId, role: "owner" },
        }),
      ]);

      const rawToken = "test-already-member-" + Date.now();
      const tokenHash = _hashTokenForTesting(rawToken);

      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.storeInvite.create({
          data: {
            storeId: storeAId,
            email: "invite-svc-invitee@example.com",
            role: "staff",
            tokenHash,
            expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
            invitedById: inviterUserId,
          },
        }),
      ]);

      const result = await acceptInvite(rawToken, inviteeUserId, "invite-svc-invitee@example.com");

      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.role).toBe("owner");
      }

      const invite = await platformAdmin.storeInvite.findUnique({
        where: { tokenHash },
      });
      expect(invite!.usedAt).not.toBeNull();
    });
  });

  describe("removeStoreMember", () => {
    it("deletes membership and writes audit log", async () => {
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.storeMembership.create({
          data: { storeId: storeAId, userId: inviterUserId, role: "owner" },
        }),
      ]);
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.storeMembership.create({
          data: { storeId: storeAId, userId: inviteeUserId, role: "staff" },
        }),
      ]);

      const result = await removeStoreMember(
        storeAId,
        inviteeUserId,
        inviterUserId,
        "invite-svc-inviter@example.com",
      );

      expect(result).toEqual({ success: true });

      const membership = await platformAdmin.storeMembership.findUnique({
        where: { storeId_userId: { storeId: storeAId, userId: inviteeUserId } },
      });
      expect(membership).toBeNull();

      const logs = await platformAdmin.auditLog.findMany({
        where: { storeId: storeAId, action: "membership.delete" },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].actorId).toBe(inviterUserId);
      expect(logs[0].actorEmail).toBe("invite-svc-inviter@example.com");
      expect(logs[0].entityType).toBe("store_membership");
      expect((logs[0].before as Record<string, unknown>)?.userId).toBe(inviteeUserId);
      expect((logs[0].before as Record<string, unknown>)?.role).toBe("staff");
    });

    it("rejects removal of last owner", async () => {
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.storeMembership.create({
          data: { storeId: storeAId, userId: inviterUserId, role: "owner" },
        }),
      ]);

      const result = await removeStoreMember(
        storeAId,
        inviterUserId,
        inviterUserId,
        "invite-svc-inviter@example.com",
      );

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("last owner");
      }

      const membership = await platformAdmin.storeMembership.findUnique({
        where: { storeId_userId: { storeId: storeAId, userId: inviterUserId } },
      });
      expect(membership).not.toBeNull();
    });

    it("returns error when member not found", async () => {
      const result = await removeStoreMember(
        storeAId,
        "nonexistent-user-id",
        inviterUserId,
        "invite-svc-inviter@example.com",
      );

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("Member not found");
      }
    });
  });

  describe("cross-store isolation", () => {
    it("invite for store A is not readable via storeScoped(storeB)", async () => {
      await createInvite(baseInput({ email: "cross-store-test@example.com" }));

      const scopedB = storeScoped(storeBId);
      const invites = await scopedB.storeInvite.findMany();

      expect(invites.every((i: { storeId: string }) => i.storeId !== storeAId)).toBe(true);
    });
  });
});
