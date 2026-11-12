import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";

vi.mock("./session", () => ({
  requirePlatformAdmin: vi.fn().mockResolvedValue({
    user: { id: "catalog-test-admin", email: "catalog-admin@platform.test", role: "platform_admin", twoFactorEnabled: true },
  }),
}));

const fakeState = vi.hoisted(() => ({
  fetch: (async () => new Response("unscripted", { status: 500 })) as typeof fetch,
}));

vi.mock("../assistant/model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assistant/model")>();
  return {
    ...actual,
    createAssistantModel: () => actual.createAssistantModel({ fetch: fakeState.fetch }),
  };
});

import { createFakeAnthropicFetch } from "../assistant/messages-api-double";
import {
  approveAttributeProposal,
  listAttributeProposals,
  proposeProductAttributes,
  rejectAttributeProposal,
  approveProduct,
  rejectProduct,
  updateReviewProduct,
  listReviewProducts,
  getReviewStats,
} from "./catalog-actions";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t125-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!hasDb)("Catalog review actions (DB integration)", () => {
  let raw: PrismaClient;
  const createdIds: string[] = [];

  async function asAdmin<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return fn(tx as unknown as PrismaClient);
    });
  }

  async function seed(name: string, status = "needs_review", extra: Record<string, unknown> = {}) {
    return asAdmin(async (tx) => {
      const p = await tx.masterProduct.create({ data: { name: `${RUN} ${name}`, status, ...extra } });
      createdIds.push(p.id);
      return p;
    });
  }
  const audits = (id: string, action: string) =>
    asAdmin((tx) => tx.auditLog.findMany({ where: { entityId: id, action } }));

  beforeAll(async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("ASSISTANT_MODEL", "");
    raw = testPrismaClient();
    await raw.$connect();
    await asAdmin((tx) =>
      tx.user.upsert({
        where: { email: "catalog-admin@platform.test" },
        update: {},
        create: { id: "catalog-test-admin", email: "catalog-admin@platform.test", name: "Catalog Test Admin", emailVerified: true },
      }),
    );
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await asAdmin(async (tx) => {
      await tx.auditLog.deleteMany({ where: { entityId: { in: createdIds } } }).catch(() => {});
      await tx.masterProduct.deleteMany({ where: { id: { in: createdIds } } });
      await tx.ingredient.deleteMany({ where: { name: { startsWith: RUN } } });
      await tx.user.deleteMany({ where: { id: "catalog-test-admin" } }).catch(() => {});
    });
    await raw.$disconnect();
  });

  it("approve: needs_review -> active with one catalog.approve audit row", async () => {
    const p = await seed("approve");
    expect(await approveProduct(p.id)).toEqual({ success: true });
    const after = await asAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id: p.id } }));
    expect(after.status).toBe("active");
    expect(await audits(p.id, "catalog.approve")).toHaveLength(1);
  });

  it("approve: unknown product returns an error", async () => {
    expect(await approveProduct("does-not-exist")).toEqual({ error: "Product not found" });
  });

  it("reject: needs_review -> rejected with one catalog.reject audit row", async () => {
    const p = await seed("reject");
    expect(await rejectProduct(p.id)).toEqual({ success: true });
    const after = await asAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id: p.id } }));
    expect(after.status).toBe("rejected");
    expect(await audits(p.id, "catalog.reject")).toHaveLength(1);
  });

  it("update: changes fields and audits before/after", async () => {
    const p = await seed("update", "needs_review", { description: "old desc" });
    expect(await updateReviewProduct(p.id, { name: "New Name", description: "New desc" })).toEqual({ success: true });
    const after = await asAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id: p.id } }));
    expect(after.name).toBe("New Name");
    expect(after.description).toBe("New desc");
    const rows = await audits(p.id, "catalog.edit");
    expect(rows).toHaveLength(1);
    expect(rows[0].before).toMatchObject({ name: `${RUN} update`, description: "old desc" });
    expect(rows[0].after).toMatchObject({ name: "New Name", description: "New desc" });
  });

  it("update: rejects a blank name and changes nothing", async () => {
    const name = "";
    const p = await seed("blank");
    expect(await updateReviewProduct(p.id, { name })).toEqual({ error: "Name is required" });
    const after = await asAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id: p.id } }));
    expect(after.name).toBe(`${RUN} blank`);
    expect(await audits(p.id, "catalog.edit")).toHaveLength(0);
  });

  it("list: filters by status with correct total/page/pageSize", async () => {
    const tag = `${RUN}-list`;
    await seed("l1", `${tag}-active`);
    await seed("l2", `${tag}-review`);
    await seed("l3", `${tag}-rejected`);
    const res = await listReviewProducts({ status: `${tag}-review`, page: 1, pageSize: 10 });
    expect(res.products).toHaveLength(1);
    expect(res.products[0].name).toBe(`${RUN} l2`);
    expect(res).toMatchObject({ total: 1, page: 1, pageSize: 10 });
  });

  it("stats: counts reflect seeded rows", async () => {
    const created = [
      await seed("s1", "needs_review"),
      await seed("s2", "needs_review"),
      await seed("s3", "active"),
      await seed("s4", "rejected"),
    ];
    // Other files insert active master products at the same time, so a global
    // before/after delta is not stable. Hold a share lock, then compare
    // getReviewStats to a recount and to these four rows.
    const stats = await raw.$transaction(async (tx) => {
      await tx.$executeRaw`LOCK TABLE master_products IN SHARE MODE`;
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      const [live, needsReview, active, rejected, mine] = await Promise.all([
        getReviewStats(),
        tx.masterProduct.count({ where: { status: "needs_review" } }),
        tx.masterProduct.count({ where: { status: "active" } }),
        tx.masterProduct.count({ where: { status: "rejected" } }),
        tx.masterProduct.findMany({
          where: { id: { in: created.map((p) => p.id) } },
          select: { status: true },
        }),
      ]);
      expect(live).toEqual({
        needsReview,
        active,
        rejected,
        total: needsReview + active + rejected,
      });
      expect(mine.map((p) => p.status).sort()).toEqual([
        "active",
        "needs_review",
        "needs_review",
        "rejected",
      ]);
      return live;
    }, { timeout: 20_000 });
    expect(stats.needsReview).toBeGreaterThanOrEqual(2);
    expect(stats.active).toBeGreaterThanOrEqual(1);
    expect(stats.rejected).toBeGreaterThanOrEqual(1);
  });

  it("concurrent approve: exactly one audit row, product active (TOCTOU closed)", async () => {
    const p = await seed("race");
    const results = await Promise.all([approveProduct(p.id), approveProduct(p.id), approveProduct(p.id)]);
    expect(results.every((r) => r.success)).toBe(true);
    const after = await asAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id: p.id } }));
    expect(after.status).toBe("active");
    expect(await audits(p.id, "catalog.approve")).toHaveLength(1);
  });

  it("concurrent approve + reject: serialize, second audit row sees the first's result", async () => {
    const p = await seed("race2");
    await Promise.all([approveProduct(p.id), rejectProduct(p.id)]);
    const after = await asAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id: p.id } }));
    const rows = await asAdmin((tx) => tx.auditLog.findMany({ where: { entityId: p.id } }));
    expect(rows).toHaveLength(2);
    // Order by the audit chain (not createdAt): the first row saw needs_review,
    // the second saw the first row's resulting status.
    const first = rows.find((r) => (r.before as { status: string }).status === "needs_review")!;
    const second = rows.find((r) => r !== first)!;
    expect((second.before as { status: string }).status).toBe((first.after as { status: string }).status);
    expect(after.status).toBe((second.after as { status: string }).status);
  });

  function scriptAttributes(toolInput: Record<string, unknown>) {
    fakeState.fetch = createFakeAnthropicFetch({
      expectedKey: "sk-ant-test",
      steps: [{ kind: "tool", toolName: "product_attributes", toolInput }],
    }).fetch;
  }
  const attributesOf = (id: string) =>
    asAdmin((tx) => tx.masterProduct.findUniqueOrThrow({
      where: { id },
      include: { ingredients: { include: { ingredient: true } } },
    }));

  it("attributes: a proposal waits for review and changes nothing until approved", async () => {
    const p = await seed("propose", "active", { description: "Peanut and onion blend" });
    scriptAttributes({ ingredients: [`${RUN} peanut`], allergens: ["peanuts"], dietaryClaims: ["halal"] });
    const proposed = await proposeProductAttributes(p.id);
    expect(proposed.success).toBe(true);
    const proposal = await asAdmin((tx) => tx.attributeProposal.findUniqueOrThrow({ where: { id: proposed.proposalId! } }));
    expect(proposal).toMatchObject({ status: "pending", allergensRead: true, allergens: ["peanuts"] });
    const after = await attributesOf(p.id);
    expect(after).toMatchObject({ allergensStatus: "unknown", dietaryStatus: "unknown", ingredientsStatus: "unknown" });
    expect(after.ingredients).toHaveLength(0);
  });

  it("attributes: approve marks read groups reviewed, links ingredients by local name, leaves unread groups unknown", async () => {
    const pepper = await asAdmin((tx) => tx.ingredient.create({
      data: { name: `${RUN} scotch bonnet pepper`, synonyms: { create: { term: `${RUN} ata rodo`, language: "yo" } } },
    }));
    const p = await seed("approve-attrs", "active");
    scriptAttributes({ ingredients: [`${RUN} Ata Rodo`, `${RUN} onion`], allergens: null, dietaryClaims: ["vegan", "halal"] });
    const { proposalId } = await proposeProductAttributes(p.id);
    expect(await approveAttributeProposal(proposalId!)).toEqual({ success: true });

    const after = await attributesOf(p.id);
    expect(after).toMatchObject({ ingredientsStatus: "reviewed", dietaryStatus: "reviewed", allergensStatus: "unknown" });
    expect(after.dietaryClaims.sort()).toEqual(["halal", "vegan"]);
    expect(after.ingredients.map((link) => link.ingredient.name).sort()).toEqual([`${RUN} onion`, `${RUN} scotch bonnet pepper`]);
    expect(after.ingredients.find((link) => link.ingredient.name.endsWith("pepper"))!.ingredientId).toBe(pepper.id);
    expect(await audits(p.id, "catalog.attributes_approve")).toHaveLength(1);
    expect(await approveAttributeProposal(proposalId!)).toEqual({ error: "Proposal already reviewed" });
  });

  it("attributes: reject leaves the product's attributes as they were", async () => {
    const p = await seed("reject-attrs", "active");
    scriptAttributes({ ingredients: null, allergens: [], dietaryClaims: null });
    const { proposalId } = await proposeProductAttributes(p.id);
    expect(await rejectAttributeProposal(proposalId!)).toEqual({ success: true });
    const proposal = await asAdmin((tx) => tx.attributeProposal.findUniqueOrThrow({ where: { id: proposalId! } }));
    expect(proposal.status).toBe("rejected");
    expect((await attributesOf(p.id)).allergensStatus).toBe("unknown");
    expect(await audits(p.id, "catalog.attributes_reject")).toHaveLength(1);
  });

  it("attributes: an off-enum allergen read stays unknown in the queue and after approve, never 'none'", async () => {
    const p = await seed("off-enum", "active");
    scriptAttributes({ ingredients: null, allergens: ["Peanuts", "tree nuts"], dietaryClaims: null });
    const { proposalId } = await proposeProductAttributes(p.id);
    const row = (await listAttributeProposals()).find((candidate) => candidate.id === proposalId);
    expect(row?.allergens).toBeNull();
    expect(await approveAttributeProposal(proposalId!)).toEqual({ success: true });
    expect((await attributesOf(p.id)).allergensStatus).toBe("unknown");
  });

  it("attributes: a read of only blank ingredient names stays unknown in the queue and after approve, never 'none'", async () => {
    const p = await seed("blank-ingredients", "active");
    scriptAttributes({ ingredients: [" ", ""], allergens: null, dietaryClaims: null });
    const { proposalId } = await proposeProductAttributes(p.id);
    const row = (await listAttributeProposals()).find((candidate) => candidate.id === proposalId);
    expect(row?.ingredients).toBeNull();
    expect(await approveAttributeProposal(proposalId!)).toEqual({ success: true });
    expect((await attributesOf(p.id)).ingredientsStatus).toBe("unknown");

    // A proposal stored before the rule, read but empty, still cannot make ingredients reviewed.
    const legacy = await asAdmin((tx) => tx.attributeProposal.create({
      data: { productId: p.id, ingredientsRead: true, ingredients: [], allergensRead: false, dietaryRead: false },
    }));
    expect(await approveAttributeProposal(legacy.id)).toEqual({ success: true });
    const after = await attributesOf(p.id);
    expect(after.ingredientsStatus).toBe("unknown");
    expect(after.ingredients).toHaveLength(0);
  });

  it("attributes: approving one proposal supersedes the product's other pending ones", async () => {
    const p = await seed("supersede", "active");
    scriptAttributes({ ingredients: null, allergens: ["milk"], dietaryClaims: null });
    const older = (await proposeProductAttributes(p.id)).proposalId!;
    scriptAttributes({ ingredients: null, allergens: ["peanuts"], dietaryClaims: null });
    const newer = (await proposeProductAttributes(p.id)).proposalId!;

    expect(await approveAttributeProposal(newer)).toEqual({ success: true });
    const stale = await asAdmin((tx) => tx.attributeProposal.findUniqueOrThrow({ where: { id: older } }));
    expect(stale.status).toBe("superseded");
    expect((await listAttributeProposals()).map((row) => row.id)).not.toContain(older);
    expect(await approveAttributeProposal(older)).toEqual({ error: "Proposal already reviewed" });
    expect((await attributesOf(p.id)).allergens).toEqual(["peanuts"]);
  });
});
