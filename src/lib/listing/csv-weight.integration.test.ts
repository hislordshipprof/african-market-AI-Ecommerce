import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { healthQueryRaw, platformAdmin, storeScoped } from "../db";
import { commitImport, generatePreview } from "./csv-import";
import type { Actor } from "./service";
import {
  HOLDER_APPLICATION_NAME,
  OVERLAP_TEST_TIMEOUT_MS,
  assertNoLockWaiters,
  commitPairBehindStoreLock,
  countLockWaiters,
  delayFirstQuery,
  directUrlForLane,
  holdStoreRow,
  waitForLockWaiters,
} from "./import-lock-test-helpers";

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

  async function importAudit(storeId: string, importId: string) {
    const logs = await storeScoped(storeId).auditLog.findMany({
      where: { action: "catalog.csv_import" },
    });
    const matches = logs.filter((entry) => {
      const after = entry.after as { importId?: string } | null;
      return after?.importId === importId;
    });
    expect(matches).toHaveLength(1);
    const match = matches[0]!;
    return {
      entityType: match.entityType,
      entityId: match.entityId,
      after: match.after as {
        count: number;
        listingIds: string[];
        importId: string;
        alreadyListedSkipped: number;
      },
    };
  }

  async function overlapPair(shared: string, extra: string, delayMs?: number) {
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
    const delay = delayMs === undefined
      ? null
      : delayFirstQuery({ table: "listing_imports", value: firstPreview.importToken, ms: delayMs });
    try {
      const committed = await commitPairBehindStoreLock({
        storeId: storeAId,
        first: () => commitImport(
          storeAId,
          firstPreview.importToken,
          { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
          actor,
        ),
        second: () => commitImport(
          storeAId,
          secondPreview.importToken,
          { matchedRows: [], newItemRows: [2, 3], ambiguousResolutions: [] },
          actor,
        ),
      });
      return { ...committed, firstPreview, secondPreview, delay };
    } catch (err) {
      if (delay) await delay.restore();
      throw err;
    }
  }

  async function expectFirstFileWeights(shared: string, extra: string, secondToken: string) {
    const sharedRows = await storeScoped(storeAId).listing.findMany({
      where: { customName: shared },
      include: { variants: true },
    });
    const extraRows = await storeScoped(storeAId).listing.findMany({
      where: { customName: extra },
      include: { variants: true },
    });
    expect(sharedRows).toHaveLength(1);
    expect(sharedRows[0]!.variants).toHaveLength(1);
    expect(sharedRows[0]!.variants[0]!.weightG).toBe(907);
    expect(sharedRows[0]!.price).toBe(700);
    expect(extraRows).toHaveLength(1);
    expect(extraRows[0]!.variants[0]!.weightG).toBe(1000);
    expect(extraRows[0]!.price).toBe(400);
    const audit = await importAudit(storeAId, secondToken);
    expect(audit.after.alreadyListedSkipped).toBe(1);
    expect(audit.after.count).toBe(1);
    expect(audit.after.importId).toBe(secondToken);
    return {
      sharedVariantId: sharedRows[0]!.variants[0]!.id,
      extraVariantId: extraRows[0]!.variants[0]!.id,
    };
  }

  it("concurrent commits of overlapping files keep the first file's weights", async () => {
    const shared = `Overlap Bag ${RUN}`;
    const extra = `Overlap Extra ${RUN}`;
    const { first, second, secondPreview, delay } = await overlapPair(shared, extra);
    expect(delay).toBeNull();
    expect(first.createdCount).toBe(1);
    expect(second.createdCount).toBe(1);
    await expectFirstFileWeights(shared, extra, secondPreview.importToken);
  }, 30_000);

  it("overlapping commits keep the first file's weights when the first commit's pre-lock read takes 1.5 s", async () => {
    const shared = `Slow Overlap Bag ${RUN}`;
    const extra = `Slow Overlap Extra ${RUN}`;
    const { first, second, secondPreview, delay } = await overlapPair(shared, extra, 1_500);
    try {
      expect(delay?.fired()).toBe(true);
      expect(first.createdCount).toBe(1);
      expect(second.createdCount).toBe(1);
      await expectFirstFileWeights(shared, extra, secondPreview.importToken);
    } finally {
      await delay?.restore();
    }
  }, OVERLAP_TEST_TIMEOUT_MS);

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

  it("a short first row still stores later CSV weights and rejects an excessive cell", async () => {
    const first = `Short First ${RUN}`;
    const heavy = `Short Heavy ${RUN}`;
    const invalid = `Short Invalid ${RUN}`;
    const csv = `name,price,weight\n${first},1.00\n${heavy},45.00,50 lb\n${invalid},1.00,1001 lb\n`;
    const preview = await generatePreview(storeAId, csv, userId);
    expect(preview.errors).toEqual([{ row: 4, csvName: invalid, reason: "Weight looks too large. Check the unit" }]);
    expect(preview.newItems.map((item) => item.csvName)).toEqual([first, heavy]);

    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2, 3, 4], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(2);

    const rows = await storeScoped(storeAId).listing.findMany({
      where: { customName: { in: [first, heavy, invalid] } },
      include: { variants: true },
    });
    const byName = new Map(rows.map((row) => [row.customName, row]));
    expect(byName.get(first)?.variants[0]?.weightG).toBe(100);
    expect(byName.get(heavy)?.variants[0]?.weightG).toBe(22680);
    expect(byName.get(heavy)?.price).toBe(4500);
    expect(byName.has(invalid)).toBe(false);
  });

  async function holderSessions(): Promise<number> {
    const client = new Client({
      connectionString: directUrlForLane(),
      application_name: "import-lock-counter",
    });
    await client.connect();
    try {
      const result = await client.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE application_name = $1",
        [HOLDER_APPLICATION_NAME],
      );
      return Number(result.rows[0]?.n ?? 0);
    } finally {
      await client.end();
    }
  }

  it("waiting on the store lock names the step when nothing queues", async () => {
    const before = await holderSessions();
    const hold = await holdStoreRow(storeAId);
    const started = Date.now();
    try {
      await expect(waitForLockWaiters(hold.pid, 1, {
        label: "nothing queued",
        timeoutMs: 500,
      })).rejects.toThrow("timed out: nothing queued");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await hold.rollback();
    }
    expect(await holderSessions()).toBe(before);
    const writeStarted = Date.now();
    const created = await storeScoped(storeAId).listing.create({
      data: {
        storeId: storeAId,
        customName: `After Wait ${RUN}`,
        price: 100,
        stockMode: "status",
        status: "in_stock",
      },
    });
    expect(Date.now() - writeStarted).toBeLessThan(2_000);
    expect(created.customName).toBe(`After Wait ${RUN}`);
  }, 30_000);

  it("waiting on the store lock fails fast with the commit's own error", async () => {
    const hold = await holdStoreRow(storeAId);
    const started = Date.now();
    const commit = commitImport(
      storeAId,
      "not-a-real-token",
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    try {
      await expect(waitForLockWaiters(hold.pid, 1, {
        label: "bad token",
        settled: [commit],
      })).rejects.toThrow("Import token is invalid, expired, or already used.");
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await hold.rollback();
      await commit.catch(() => undefined);
    }
  }, 30_000);

  it("an empty selection fails the wait with the commit error", async () => {
    const preview = await generatePreview(storeAId, `name,price,weight\nEmpty Sel ${RUN},1.00,500 g\n`, userId);
    const hold = await holdStoreRow(storeAId);
    const started = Date.now();
    const commit = commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [], ambiguousResolutions: [] },
      actor,
    );
    try {
      await expect(waitForLockWaiters(hold.pid, 1, {
        label: "empty selection",
        settled: [commit],
      })).rejects.toThrow("No rows selected for import.");
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await hold.rollback();
      await commit.catch(() => undefined);
    }
    const pending = await storeScoped(storeAId).listingImport.findUnique({ where: { id: preview.importToken } });
    expect(pending?.status).toBe("pending");
  }, 30_000);

  it("wait failure with two queued commits releases the holder and drains both", async () => {
    const shared = `Drain Shared ${RUN}`;
    const extra = `Drain Extra ${RUN}`;
    const firstPreview = await generatePreview(storeAId, `name,price,weight\n${shared},7.00,2 lb\n`, userId);
    const secondPreview = await generatePreview(
      storeAId,
      `name,price,weight\n${shared},7.00,500 g\n${extra},4.00,1 kg\n`,
      userId,
    );
    const hold = await holdStoreRow(storeAId);
    const first = commitImport(
      storeAId,
      firstPreview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    let second: Promise<unknown> | undefined;
    try {
      await waitForLockWaiters(hold.pid, 1, {
        label: "first commit queued on store lock",
        settled: [first],
      });
      second = commitImport(
        storeAId,
        secondPreview.importToken,
        { matchedRows: [], newItemRows: [2, 3], ambiguousResolutions: [] },
        actor,
      );
      await waitForLockWaiters(hold.pid, 2, {
        label: "second commit queued on store lock",
        settled: [first, second],
      });
      await expect(waitForLockWaiters(hold.pid, 3, {
        label: "third waiter",
        timeoutMs: 400,
        settled: [first, second],
      })).rejects.toThrow("timed out: third waiter");
    } finally {
      await hold.rollback();
      await Promise.allSettled([first, second].filter((job): job is Promise<unknown> => !!job));
    }
    const writeStarted = Date.now();
    await storeScoped(storeAId).listing.create({
      data: {
        storeId: storeAId,
        customName: `After Drain ${RUN}`,
        price: 125,
        stockMode: "status",
        status: "in_stock",
      },
    });
    expect(Date.now() - writeStarted).toBeLessThan(2_000);
    await expectFirstFileWeights(shared, extra, secondPreview.importToken);
  }, 30_000);

  it("second commit fails before locking while first remains queued", async () => {
    const name = `Queued First ${RUN}`;
    const preview = await generatePreview(storeAId, `name,price,weight\n${name},3.00,2 lb\n`, userId);
    const hold = await holdStoreRow(storeAId);
    let firstSettled = false;
    const first = commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    let second: Promise<unknown> | undefined;
    try {
      await waitForLockWaiters(hold.pid, 1, {
        label: "first commit queued on store lock",
        settled: [first],
      });
      second = commitImport(
        storeAId,
        "not-a-real-token",
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      );
      const started = Date.now();
      await expect(waitForLockWaiters(hold.pid, 2, {
        label: "second commit queued on store lock",
        settled: [first, second],
      })).rejects.toThrow("Import token is invalid, expired, or already used.");
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(firstSettled).toBe(false);
    } finally {
      await hold.rollback();
      await second?.catch(() => undefined);
    }
    const created = await first;
    expect(created.createdCount).toBe(1);
    const stored = await storedVariant(storeAId, created.listingIds[0]!);
    expect(stored.variant.weightG).toBe(907);
  }, 30_000);

  it("holding a store row that does not exist throws store row not locked", async () => {
    await expect(holdStoreRow(crypto.randomUUID())).rejects.toThrow("store row not locked");
  }, 30_000);

  it("missing-store holder and repeated cleanup leave no connection behind", async () => {
    const before = await holderSessions();
    await expect(holdStoreRow(crypto.randomUUID())).rejects.toThrow("store row not locked");
    expect(await holderSessions()).toBe(before);
    const hold = await holdStoreRow(storeAId);
    expect(await holderSessions()).toBe(before + 1);
    await hold.rollback();
    await hold.rollback();
    await hold.commit();
    expect(await holderSessions()).toBe(before);
  }, 30_000);

  it("waiter count excludes another store and rejects a nonzero baseline", async () => {
    const storeC = await raw.store.create({
      data: { slug: `csv-weight-c-${RUN}`, name: `CSV Weight C ${RUN}`, themePreset: "palm-and-shea" },
    });
    const holdA = await holdStoreRow(storeAId);
    const holdB = await holdStoreRow(storeBId);
    const holdC = await holdStoreRow(storeC.id);
    const waiters: Array<{ client: Client; pid: number }> = [];
    const terminate = async (pid: number) => {
      const control = new Client({ connectionString: directUrlForLane(), application_name: "import-lock-counter" });
      await control.connect();
      try {
        await control.query("SELECT pg_terminate_backend($1)", [pid]);
      } finally {
        await control.end();
      }
    };
    const blockOn = async (ids: string[]) => {
      const client = new Client({ connectionString: directUrlForLane(), application_name: "import-lock-waiter" });
      client.on("error", () => undefined);
      await client.connect();
      await client.query("BEGIN");
      const who = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = Number(who.rows[0]?.pid ?? 0);
      const blocked = ids.length === 1
        ? client.query("SELECT 1 FROM stores WHERE id = $1 FOR UPDATE", ids)
        : client.query("SELECT 1 FROM stores WHERE id = $1 OR id = $2 FOR UPDATE", ids);
      void blocked.catch(() => undefined);
      waiters.push({ client, pid });
      return pid;
    };
    const releaseWaiter = async (pid: number, holderPid: number) => {
      await terminate(pid);
      const quiet = Date.now() + 2_000;
      while ((await countLockWaiters(holderPid)) !== 0) {
        if (Date.now() > quiet) throw new Error("timed out: waiter cleared");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      const onB = await blockOn([storeBId]);
      await waitForLockWaiters(holdB.pid, 1, { label: "store B waiter" });
      expect(await countLockWaiters(holdA.pid)).toBe(0);
      expect(await countLockWaiters(holdC.pid)).toBe(0);
      await releaseWaiter(onB, holdB.pid);

      const onBoth = await blockOn([storeAId, storeBId]);
      await waitForLockWaiters(holdA.pid, 1, { label: "shared waiter" });
      expect(await countLockWaiters(holdA.pid)).toBe(1);
      expect(await countLockWaiters(holdC.pid)).toBe(0);
      await releaseWaiter(onBoth, holdA.pid);

      await assertNoLockWaiters(holdA.pid);
      const onA = await blockOn([storeAId]);
      await waitForLockWaiters(holdA.pid, 1, { label: "baseline waiter" });
      await expect(assertNoLockWaiters(holdA.pid)).rejects.toThrow(/nonzero lock-waiter baseline: 1/);
      await releaseWaiter(onA, holdA.pid);
    } finally {
      for (const waiter of waiters) {
        await terminate(waiter.pid).catch(() => undefined);
        await waiter.client.end().catch(() => undefined);
      }
      await holdA.rollback().catch(() => undefined);
      await holdB.rollback().catch(() => undefined);
      await holdC.rollback().catch(() => undefined);
      await raw.store.delete({ where: { id: storeC.id } }).catch(() => undefined);
    }
  }, 30_000);

  it("store B cannot read, change or delete the overlapping import's rows", async () => {
    const shared = `Iso Shared ${RUN}`;
    const extra = `Iso Extra ${RUN}`;
    const { firstPreview, secondPreview, delay } = await overlapPair(shared, extra);
    expect(delay).toBeNull();
    const tokens = [firstPreview.importToken, secondPreview.importToken];
    const imports = await storeScoped(storeAId).listingImport.findMany({ where: { id: { in: tokens } } });
    expect(imports.map((row) => row.id).sort()).toEqual([...tokens].sort());
    expect(imports.every((row) => row.status === "committed")).toBe(true);
    const firstAudit = await importAudit(storeAId, firstPreview.importToken);
    const secondAudit = await importAudit(storeAId, secondPreview.importToken);
    expect(firstAudit.entityType).toBe("listing");
    expect(secondAudit.entityType).toBe("listing");
    expect(firstAudit.entityId).not.toBe(firstPreview.importToken);
    expect(secondAudit.after.importId).toBe(secondPreview.importToken);
    const ids = await expectFirstFileWeights(shared, extra, secondPreview.importToken);
    const variantIds = [ids.sharedVariantId, ids.extraVariantId];
    expect(variantIds.every((id) => id.length > 0)).toBe(true);

    expect(await storeScoped(storeBId).listing.findMany({
      where: { customName: { in: [shared, extra] } },
    })).toEqual([]);
    expect(await storeScoped(storeBId).listingImport.findMany({ where: { id: { in: tokens } } })).toEqual([]);
    expect(await storeScoped(storeBId).listingVariant.findMany({ where: { id: { in: variantIds } } })).toEqual([]);
    const foreignAudits = await storeScoped(storeBId).auditLog.findMany({ where: { action: "catalog.csv_import" } });
    expect(foreignAudits.filter((entry) => tokens.includes((entry.after as { importId?: string } | null)?.importId ?? ""))).toEqual([]);
    expect(await storeScoped(storeBId).listingVariant.updateMany({
      where: { id: { in: variantIds } },
      data: { weightG: 1 },
    })).toEqual({ count: 0 });
    expect(await storeScoped(storeBId).listingVariant.deleteMany({
      where: { id: { in: variantIds } },
    })).toEqual({ count: 0 });

    const reread = await expectFirstFileWeights(shared, extra, secondPreview.importToken);
    expect(reread.sharedVariantId).toBe(ids.sharedVariantId);
    expect(reread.extraVariantId).toBe(ids.extraVariantId);
  }, 30_000);

  it("overlap isolation has positive A controls and runs independently", async () => {
    const shared = `Solo Iso Shared ${RUN}`;
    const extra = `Solo Iso Extra ${RUN}`;
    const { first, second, firstPreview, secondPreview } = await overlapPair(shared, extra);
    expect(first.createdCount).toBe(1);
    expect(second.createdCount).toBe(1);
    const tokens = [firstPreview.importToken, secondPreview.importToken];
    const imports = await storeScoped(storeAId).listingImport.findMany({ where: { id: { in: tokens } } });
    expect(imports).toHaveLength(2);
    const audits = await Promise.all(tokens.map((token) => importAudit(storeAId, token)));
    expect(audits.every((audit) => audit.entityType === "listing" && audit.after.importId && audit.entityId !== audit.after.importId)).toBe(true);
    const ids = await expectFirstFileWeights(shared, extra, secondPreview.importToken);
    expect([ids.sharedVariantId, ids.extraVariantId].filter(Boolean)).toHaveLength(2);
    expect(await storeScoped(storeBId).listingVariant.updateMany({
      where: { id: { in: [ids.sharedVariantId, ids.extraVariantId] } },
      data: { weightG: 1 },
    })).toEqual({ count: 0 });
    const still = await storeScoped(storeAId).listingVariant.findMany({
      where: { id: { in: [ids.sharedVariantId, ids.extraVariantId] } },
    });
    expect(still.map((row) => row.weightG).sort((a, b) => a - b)).toEqual([907, 1000]);
  }, 30_000);

  it("the suite connects as app_runtime", async () => {
    const rows = (await healthQueryRaw`SELECT current_user`) as { current_user: string }[];
    expect(rows[0]?.current_user).toBe("app_runtime");
  });
});
