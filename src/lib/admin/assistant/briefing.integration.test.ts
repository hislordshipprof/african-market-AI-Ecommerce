import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testPrismaClient } from "../../test-prisma";
import { adminBriefing, briefingSummary, type BriefingItem } from "./briefing";

const RUN = `t834b-${Date.now()}`;
const hasDb = !!process.env.DATABASE_URL;
const DAY = 86_400_000;

describe.skipIf(!hasDb)("platform admin briefing (#834)", () => {
  const owner = testPrismaClient();
  const stuckId = crypto.randomUUID();
  const freshId = crypto.randomUUID();
  const stuckName = `Stuck Market ${RUN}`;
  const freshName = `Fresh Market ${RUN}`;
  let applicationId = "";

  beforeAll(async () => {
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, address_line1, zip, created_at, updated_at) VALUES (${stuckId}, ${stuckName}, ${`stuck-${RUN}`}, 'setup', '1 Way', '20782', ${new Date(Date.now() - 5 * DAY)}, now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, address_line1, zip, created_at, updated_at) VALUES (${freshId}, ${freshName}, ${`fresh-${RUN}`}, 'setup', '1 Way', '20782', ${new Date(Date.now() - 1 * DAY)}, now())`;
      applicationId = (await tx.storeApplication.create({
        data: { businessName: `Brief ${RUN}`, storeType: "african", addressLine1: "9 St", city: "Laurel", state: "MD", zip: "20707", ownerName: "Ada", email: `brief-${RUN}@example.com`, phone: `+1301${String(Date.now()).slice(-7)}`, offersPickup: true },
      })).id;
    });
  });

  afterAll(async () => {
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.storeApplication.deleteMany({ where: { id: applicationId } });
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${stuckId}, ${freshId})`;
    });
    await owner.$disconnect();
  });

  it("reads without a signed-in admin, so the daily email can run it, and lists stores in setup for more than 3 days only", async () => {
    const briefing = await adminBriefing(new Date());
    const stuck = briefing.items.find((item) => item.key === "onboarding_stuck");
    expect(stuck?.names).toContain(stuckName);
    expect(stuck?.names).not.toContain(freshName);
    expect(stuck?.href).toBe("/admin/stores");
    expect(stuck?.ask).toBeTruthy();
  });

  it("counts new applications with a next step that checks them", async () => {
    const briefing = await adminBriefing(new Date());
    const applications = briefing.items.find((item) => item.key === "applications");
    expect(applications?.count).toBeGreaterThanOrEqual(1);
    expect(applications?.href).toBe("/admin/applications");
  });
});

describe("briefing summary", () => {
  const item = (count: number): BriefingItem => ({ key: "refund_failed", count, incomplete: false, label: `${count} refunds failed`, names: [], href: "/admin/orders", ask: "Which refunds failed?" });

  it("says nothing is waiting in one line when no item has a count", () => {
    expect(briefingSummary([])).toBe("Nothing is waiting for an admin today.");
  });

  it("names how many things wait when some do", () => {
    expect(briefingSummary([item(2), item(1)])).toMatch(/^2 things/);
  });
});
