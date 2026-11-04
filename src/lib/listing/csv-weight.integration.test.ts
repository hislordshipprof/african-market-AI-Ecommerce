import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { healthQueryRaw, platformAdmin, storeScoped } from "../db";
import { resolveDirectUrl } from "../env";
import { commitImport, generatePreview } from "./csv-import";
import type { Actor } from "./service";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `w215-${Date.now()}`;

const selectionOf = (rows: number[]) => ({
  matchedRows: rows,
  newItemRows: [] as number[],
  ambiguousResolutions: [] as Array<{ row: number; masterProductId: string }>,
});

describe.skipIf(!hasDb)("csv weight commit (lane DB, app_runtime)", () => {
  let raw: PrismaClient;
  let storeAId = "";
  let storeBId = "";
  let userId = "";
  let actor: Actor;
  const masterIds: string[] = [];
  let weightedId = "";
  let ambigId = "";

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await raw.$connect();

    const storeA = await raw.store.create({
      data: { slug: `csv-weight-a-${RUN}`, name: `CSV Weight A ${RUN}`, themePreset: "palm-and-shea" },
    });
    const storeB = await raw.store.create({
      data: { slug: `csv-weight-b-${RUN}`, name: `CSV Weight B ${RUN}`, themePreset: "lagoon-and-coral" },
    });
    storeAId = storeA.id;
    storeBId = storeB.id;

    const user = await raw.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `csv-weight-${RUN}@example.com`,
        name: "CSV Weight",
        emailVerified: true,
      },
    });
    userId = user.id;
    actor = { id: user.id, email: user.email };

    const weighted = await platformAdmin.masterProduct.create({
      data: { name: `Weighted Flour ${RUN}`, weightG: 11340, status: "active" },
    });
    weightedId = weighted.id;
    masterIds.push(weighted.id);

    const bare = await platformAdmin.masterProduct.create({
      data: { name: `Bare Flour ${RUN}`, weightG: null, status: "active" },
    });
    masterIds.push(bare.id);

    const ambigA = await platformAdmin.masterProduct.create({
      data: { name: `Ambig Alpha ${RUN}`, weightG: null, status: "active" },
    });
    const ambigB = await platformAdmin.masterProduct.create({
      data: { name: `Ambig Beta ${RUN}`, weightG: null, status: "active" },
    });
    ambigId = ambigA.id;
    masterIds.push(ambigA.id, ambigB.id);
    await platformAdmin.productSynonym.create({ data: { productId: ambigA.id, term: `Ambig Grain ${RUN}` } });
    await platformAdmin.productSynonym.create({ data: { productId: ambigB.id, term: `Ambig Grain ${RUN}` } });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.$transaction([
      raw.$executeRaw`SET LOCAL ROLE app_user`,
      raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      raw.auditLog.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
      raw.stockEvent.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
      raw.listingVariant.deleteMany({ where: { listing: { storeId: { in: [storeAId, storeBId] } } } }),
      raw.listing.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
      raw.listingImport.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
      raw.productSynonym.deleteMany({ where: { productId: { in: masterIds } } }),
      raw.masterProduct.deleteMany({ where: { id: { in: masterIds } } }),
    ]);
    await raw.user.deleteMany({ where: { id: userId } });
    await raw.store.deleteMany({ where: { id: { in: [storeAId, storeBId] } } });
    await raw.$disconnect();
  });

  async function storedVariant(storeId: string, listingId: string) {
    const listing = await storeScoped(storeId).listing.findUnique({
      where: { id: listingId },
      include: { variants: true },
    });
    expect(listing).toBeTruthy();
    expect(listing!.variants).toHaveLength(1);
    return { listing: listing!, variant: listing!.variants[0]! };
  }

  it("commit stores the CSV weight ahead of the master weight and the fallback", async () => {
    const matched = await generatePreview(
      storeAId,
      `name,price,weight\nWeighted Flour ${RUN},10.00,2 lb\n`,
      userId,
    );
    expect(matched.matches).toHaveLength(1);
    const matchedResult = await commitImport(
      storeAId,
      matched.importToken,
      selectionOf([2]),
      actor,
    );
    const matchedStored = await storedVariant(storeAId, matchedResult.listingIds[0]!);
    expect(matchedStored.variant.weightG).toBe(907);
    expect(matchedStored.listing.price).toBe(1000);
    expect(matchedStored.variant.price).toBe(1000);

    const emptyCell = await generatePreview(
      storeBId,
      `name,price,weight\nWeighted Flour ${RUN},10.00,\n`,
      userId,
    );
    expect(emptyCell.matches).toHaveLength(1);
    const emptyResult = await commitImport(storeBId, emptyCell.importToken, selectionOf([2]), actor);
    const emptyStored = await storedVariant(storeBId, emptyResult.listingIds[0]!);
    expect(emptyStored.variant.weightG).toBe(11340);
    expect(emptyStored.listing.price).toBe(1000);
    expect(emptyStored.variant.price).toBe(1000);

    const custom = await generatePreview(
      storeAId,
      `name,price,weight\nCustom Spice ${RUN},6.50,500 g\n`,
      userId,
    );
    expect(custom.newItems).toHaveLength(1);
    const customResult = await commitImport(
      storeAId,
      custom.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    const customStored = await storedVariant(storeAId, customResult.listingIds[0]!);
    expect(customStored.variant.weightG).toBe(500);
    expect(customStored.listing.price).toBe(650);
    expect(customStored.variant.price).toBe(650);

    const plain = await generatePreview(storeBId, `name,price\nCustom Spice ${RUN},6.50\n`, userId);
    const plainResult = await commitImport(
      storeBId,
      plain.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    const plainStored = await storedVariant(storeBId, plainResult.listingIds[0]!);
    expect(plainStored.variant.weightG).toBe(100);
    expect(plainStored.listing.price).toBe(customStored.listing.price);
    expect(plainStored.variant.price).toBe(customStored.variant.price);

    const noCell = await generatePreview(
      storeAId,
      `name,price,weight\nCustom Plain ${RUN},4.00,\n`,
      userId,
    );
    const noCellResult = await commitImport(
      storeAId,
      noCell.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    const noCellStored = await storedVariant(storeAId, noCellResult.listingIds[0]!);
    expect(noCellStored.variant.weightG).toBe(100);
    expect(noCellStored.listing.price).toBe(400);
    expect(noCellStored.variant.price).toBe(400);

    const ambiguous = await generatePreview(
      storeAId,
      `name,price,weight\nAmbig Grain ${RUN},8.00,3 kg\n`,
      userId,
    );
    expect(ambiguous.ambiguous).toHaveLength(1);
    const ambiguousResult = await commitImport(
      storeAId,
      ambiguous.importToken,
      {
        matchedRows: [],
        newItemRows: [],
        ambiguousResolutions: [{ row: 2, masterProductId: ambigId }],
      },
      actor,
    );
    const ambiguousStored = await storedVariant(storeAId, ambiguousResult.listingIds[0]!);
    expect(ambiguousStored.listing.masterProductId).toBe(ambigId);
    expect(ambiguousStored.variant.weightG).toBe(3000);
    expect(ambiguousStored.listing.price).toBe(800);
    expect(ambiguousStored.variant.price).toBe(800);
  });

  it("storeScoped(storeB) cannot read, change, delete or create store A's imported variants", async () => {
    const preview = await generatePreview(
      storeAId,
      `name,price,weight\nIsolated Bag ${RUN},9.00,2 lb\n`,
      userId,
    );
    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    const stored = await storedVariant(storeAId, result.listingIds[0]!);
    expect(stored.variant.weightG).toBe(907);

    const hidden = await storeScoped(storeBId).listingVariant.findMany({
      where: { id: stored.variant.id },
    });
    expect(hidden).toEqual([]);

    const updated = await storeScoped(storeBId).listingVariant.updateMany({
      where: { id: stored.variant.id },
      data: { weightG: 1 },
    });
    const deleted = await storeScoped(storeBId).listingVariant.deleteMany({
      where: { id: stored.variant.id },
    });
    expect(updated.count).toBe(0);
    expect(deleted.count).toBe(0);

    await expect(
      storeScoped(storeBId).listingVariant.create({
        data: { listingId: stored.listing.id, label: "Other", price: 1, weightG: 1 },
      }),
    ).rejects.toThrow(/row-level security|42501/i);

    const after = await storedVariant(storeAId, stored.listing.id);
    expect(after.variant.weightG).toBe(907);
  });

  it("a concurrent second commit of the same token writes weights once", async () => {
    const preview = await generatePreview(
      storeAId,
      `name,price,weight\nOnce Bag ${RUN},5.00,2 lb\n`,
      userId,
    );
    const selection = { matchedRows: [] as number[], newItemRows: [2], ambiguousResolutions: [] };
    const results = await Promise.allSettled([
      commitImport(storeAId, preview.importToken, selection, actor),
      commitImport(storeAId, preview.importToken, selection, actor),
    ]);
    const fulfilled = results.filter((row) => row.status === "fulfilled");
    const rejected = results.filter((row) => row.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe(
      "This import has already been committed.",
    );

    const listings = await storeScoped(storeAId).listing.findMany({
      where: { customName: `Once Bag ${RUN}` },
      include: { variants: true },
    });
    expect(listings).toHaveLength(1);
    expect(listings[0]!.variants).toHaveLength(1);
    expect(listings[0]!.variants[0]!.weightG).toBe(907);

    const again = await generatePreview(
      storeBId,
      `name,price,weight\nRetry Bag ${RUN},5.00,500 g\n`,
      userId,
    );
    const retrySelection = { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] };
    await commitImport(storeBId, again.importToken, retrySelection, actor);
    await expect(
      commitImport(storeBId, again.importToken, retrySelection, actor),
    ).rejects.toThrow("This import has already been committed.");
    const retries = await storeScoped(storeBId).listing.findMany({
      where: { customName: `Retry Bag ${RUN}` },
      include: { variants: true },
    });
    expect(retries).toHaveLength(1);
    expect(retries[0]!.variants[0]!.weightG).toBe(500);
  });

  it("concurrent commits of overlapping files keep the first file's weights", async () => {
    const shared = `Overlap Bag ${RUN}`;
    const extra = `Overlap Extra ${RUN}`;
    const firstPreview = await generatePreview(
      storeAId,
      `name,price,weight\n${shared},7.00,2 lb\n`,
      userId,
    );
    const secondPreview = await generatePreview(
      storeAId,
      `name,price,weight\n${shared},7.00,500 g\n${extra},4.00,1 kg\n`,
      userId,
    );
    const client = new Client({ connectionString: resolveDirectUrl() });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM stores WHERE id = $1 FOR UPDATE", [storeAId]);
      const first = commitImport(
        storeAId,
        firstPreview.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      );
      await new Promise((resolve) => setTimeout(resolve, 750));
      const second = commitImport(
        storeAId,
        secondPreview.importToken,
        { matchedRows: [], newItemRows: [2, 3], ambiguousResolutions: [] },
        actor,
      );
      await new Promise((resolve) => setTimeout(resolve, 750));
      await client.query("COMMIT");
      const [createdFirst, createdSecond] = await Promise.all([first, second]);
      expect(createdFirst.createdCount).toBe(1);
      expect(createdSecond.createdCount).toBe(1);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }

    const sharedRows = await storeScoped(storeAId).listing.findMany({
      where: { customName: shared },
      include: { variants: true },
    });
    const extraRows = await storeScoped(storeAId).listing.findMany({
      where: { customName: extra },
      include: { variants: true },
    });
    expect(sharedRows).toHaveLength(1);
    expect(sharedRows[0]!.variants[0]!.weightG).toBe(907);
    expect(extraRows).toHaveLength(1);
    expect(extraRows[0]!.variants[0]!.weightG).toBe(1000);
  });

  it("a commit that fails on its last write leaves no variant and the retry stores the CSV weight", async () => {
    const name = `Rollback Bag ${RUN}`;
    const preview = await generatePreview(
      storeAId,
      `name,price,weight\n${name},3.00,500 g\n`,
      userId,
    );
    const selection = { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] };
    const missingActor: Actor = { id: `missing-actor-${RUN}`, email: "missing@example.com" };
    await expect(commitImport(storeAId, preview.importToken, selection, missingActor)).rejects.toThrow();

    const listings = await storeScoped(storeAId).listing.findMany({ where: { customName: name } });
    const variants = await storeScoped(storeAId).listingVariant.findMany({
      where: { listing: { customName: name } },
    });
    expect(listings).toEqual([]);
    expect(variants).toEqual([]);
    const pending = await storeScoped(storeAId).listingImport.findUnique({
      where: { id: preview.importToken },
    });
    expect(pending?.status).toBe("pending");

    const retried = await commitImport(storeAId, preview.importToken, selection, actor);
    expect(retried.createdCount).toBe(1);
    const stored = await storedVariant(storeAId, retried.listingIds[0]!);
    expect(stored.variant.weightG).toBe(500);
    const rows = await storeScoped(storeAId).listing.findMany({ where: { customName: name } });
    expect(rows).toHaveLength(1);
  });

  it("an import stored before the weight column existed commits with parsed weights", async () => {
    const valid = `Valid Bag ${RUN}`;
    const invalid = `Invalid Bag ${RUN}`;
    const csv = `name,price,weight\n${valid},5.00,2 lb\n${invalid},5.00,5 lb.\n`;
    const pending = await storeScoped(storeAId).listingImport.create({
      data: { storeId: storeAId, csvText: csv, rowCount: 2, status: "pending", createdById: userId },
    });
    const result = await commitImport(
      storeAId,
      pending.id,
      { matchedRows: [], newItemRows: [2, 3], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1);
    const stored = await storedVariant(storeAId, result.listingIds[0]!);
    expect(stored.listing.customName).toBe(valid);
    expect(stored.variant.weightG).toBe(907);
    const skipped = await storeScoped(storeAId).listing.findMany({ where: { customName: invalid } });
    expect(skipped).toEqual([]);

    const duplicateCsv = `name,price,weight,weight\nDup Bag ${RUN},5.00,2 lb,3 kg\n`;
    const duplicate = await storeScoped(storeAId).listingImport.create({
      data: {
        storeId: storeAId,
        csvText: duplicateCsv,
        rowCount: 1,
        status: "pending",
        createdById: userId,
      },
    });
    await expect(
      commitImport(
        storeAId,
        duplicate.id,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      ),
    ).rejects.toThrow("No valid rows to import after re-validation.");
    const token = await storeScoped(storeAId).listingImport.findUnique({ where: { id: duplicate.id } });
    expect(token?.status).toBe("pending");
    const created = await storeScoped(storeAId).listing.findMany({ where: { customName: `Dup Bag ${RUN}` } });
    expect(created).toEqual([]);
  });

  it("the suite connects as app_runtime", async () => {
    const rows = (await healthQueryRaw`SELECT current_user`) as { current_user: string }[];
    expect(rows[0]?.current_user).toBe("app_runtime");
  });
});
