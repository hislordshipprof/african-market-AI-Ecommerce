import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
}));
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { healthQueryRaw, platformAdmin, storeScoped } from "../db";
import { runtimeDatabaseUrl } from "../env";
import { addLine, getCartWithLines, getOrCreateCart } from "../cart/service";
import { getActiveListings, getFlowCatalog, getListingDetail } from "../storefront/service";
import { seedDemoCatalog } from "../../../prisma/seed-demo-catalog";
import { commitImport, generatePreview } from "./csv-import";
import { createListing, updateListing, updateVariants, type Actor } from "./service";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `w216-${Date.now().toString(36)}`;

describe.skipIf(!hasDb)("placeholder weight on import (lane DB, app_runtime)", () => {
  let raw: PrismaClient;
  let storeAId = "";
  let storeBId = "";
  let userId = "";
  let actor: Actor;
  const masterIds: string[] = [];
  let flourId = "";
  let bareId = "";
  let hundredId = "";
  let ambigId = "";

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await raw.$connect();
    const storeA = await raw.store.create({
      data: { slug: `ph-a-${RUN}`, name: `Placeholder A ${RUN}`, themePreset: "palm-and-shea" },
    });
    const storeB = await raw.store.create({
      data: { slug: `ph-b-${RUN}`, name: `Placeholder B ${RUN}`, themePreset: "lagoon-and-coral" },
    });
    storeAId = storeA.id;
    storeBId = storeB.id;
    const user = await raw.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `ph-${RUN}@example.com`,
        name: "Placeholder",
        emailVerified: true,
      },
    });
    userId = user.id;
    actor = { id: user.id, email: user.email };

    const flour = await platformAdmin.masterProduct.create({
      data: { name: `Flour M ${RUN}`, weightG: 11340, status: "active" },
    });
    const bare = await platformAdmin.masterProduct.create({
      data: { name: `Bare Y ${RUN}`, weightG: null, status: "active" },
    });
    const hundred = await platformAdmin.masterProduct.create({
      data: { name: `Hundred Master ${RUN}`, weightG: 100, status: "active" },
    });
    const ambigA = await platformAdmin.masterProduct.create({
      data: { name: `Ambig Alpha ${RUN}`, weightG: null, status: "active" },
    });
    const ambigB = await platformAdmin.masterProduct.create({
      data: { name: `Ambig Beta ${RUN}`, weightG: null, status: "active" },
    });
    flourId = flour.id;
    bareId = bare.id;
    hundredId = hundred.id;
    ambigId = ambigA.id;
    masterIds.push(flour.id, bare.id, hundred.id, ambigA.id, ambigB.id);
    await platformAdmin.productSynonym.create({ data: { productId: ambigA.id, term: `Ambig Grain ${RUN}` } });
    await platformAdmin.productSynonym.create({ data: { productId: ambigB.id, term: `Ambig Grain ${RUN}` } });
  });

  afterAll(async () => {
    if (!raw) return;
    const ids = [storeAId, storeBId].filter(Boolean);
    await raw.$transaction([
      raw.$executeRaw`SET LOCAL ROLE app_user`,
      raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      raw.cartLine.deleteMany({ where: { storeId: { in: ids } } }),
      raw.cart.deleteMany({ where: { storeId: { in: ids } } }),
      raw.auditLog.deleteMany({ where: { storeId: { in: ids } } }),
      raw.stockEvent.deleteMany({ where: { storeId: { in: ids } } }),
      raw.listingVariant.deleteMany({ where: { listing: { storeId: { in: ids } } } }),
      raw.listing.deleteMany({ where: { storeId: { in: ids } } }),
      raw.listingImport.deleteMany({ where: { storeId: { in: ids } } }),
      raw.productSynonym.deleteMany({ where: { productId: { in: masterIds } } }),
      raw.masterProduct.deleteMany({ where: { id: { in: masterIds } } }),
    ]);
    if (userId) await raw.user.deleteMany({ where: { id: userId } });
    if (ids.length > 0) await raw.store.deleteMany({ where: { id: { in: ids } } });
    await raw.$disconnect();
  }, 120_000);

  async function variantOf(where: { customName?: string; masterProductId?: string }) {
    const listing = await storeScoped(storeAId).listing.findFirst({
      where,
      include: { variants: true },
    });
    expect(listing?.variants).toHaveLength(1);
    return { listing: listing!, variant: listing!.variants[0]! };
  }

  it("only the 100 g fallback branch is flagged and counted", async () => {
    const csv = [
      "name,price,weight",
      `Custom None ${RUN},1.00,`,
      `Flour M ${RUN},2.00,`,
      `Custom Five ${RUN},3.00,500 g`,
      `Custom Hundred ${RUN},4.00,100 g`,
      `Ambig Grain ${RUN},5.00,`,
      `Bare Y ${RUN},6.00,5 lb`,
      `Hundred Master ${RUN},7.00,`,
    ].join("\n");
    const preview = await generatePreview(storeAId, csv, userId);
    expect(preview.ambiguous.map((row) => row.row)).toEqual([6]);
    const result = await commitImport(
      storeAId,
      preview.importToken,
      {
        matchedRows: [3, 7, 8],
        newItemRows: [2, 4, 5],
        ambiguousResolutions: [{ row: 6, masterProductId: ambigId }],
      },
      actor,
    );
    expect(result.createdCount).toBe(7);
    expect(result.needsWeightCount).toBe(2);

    const customNone = await variantOf({ customName: `Custom None ${RUN}` });
    expect(customNone.variant.weightG).toBe(100);
    expect(customNone.variant.weightPlaceholder).toBe(true);
    expect(customNone.variant.price).toBe(100);
    expect(customNone.listing.price).toBe(100);

    const flour = await variantOf({ masterProductId: flourId });
    expect(flour.variant.weightG).toBe(11340);
    expect(flour.variant.weightPlaceholder).toBe(false);
    expect(flour.variant.price).toBe(200);

    const five = await variantOf({ customName: `Custom Five ${RUN}` });
    expect(five.variant.weightG).toBe(500);
    expect(five.variant.weightPlaceholder).toBe(false);

    const hundredCsv = await variantOf({ customName: `Custom Hundred ${RUN}` });
    expect(hundredCsv.variant.weightG).toBe(100);
    expect(hundredCsv.variant.weightPlaceholder).toBe(false);

    const ambiguous = await variantOf({ masterProductId: ambigId });
    expect(ambiguous.variant.weightG).toBe(100);
    expect(ambiguous.variant.weightPlaceholder).toBe(true);
    expect(ambiguous.listing.price).toBe(500);

    const bare = await variantOf({ masterProductId: bareId });
    expect(bare.variant.weightG).toBe(2268);
    expect(bare.variant.weightPlaceholder).toBe(false);
    expect(bare.listing.price).toBe(600);

    const hundredMaster = await variantOf({ masterProductId: hundredId });
    expect(hundredMaster.variant.weightG).toBe(100);
    expect(hundredMaster.variant.weightPlaceholder).toBe(false);
    expect(hundredMaster.listing.price).toBe(700);

    const audits = await storeScoped(storeAId).auditLog.findMany({
      where: { action: "catalog.csv_import" },
    });
    const entry = audits.find((row) => {
      const after = row.after as { importId?: string } | null;
      return after?.importId === preview.importToken;
    });
    expect(entry?.after).toMatchObject({ needsWeightCount: 2, count: 7 });
  });

  it("createListing, updateListing and updateVariants write false; a price-only update keeps true", async () => {
    const preview = await generatePreview(storeAId, `name,price\nPrice Only ${RUN},9.00\n`, userId);
    const imported = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    const before = await variantOf({ customName: `Price Only ${RUN}` });
    expect(before.variant.weightPlaceholder).toBe(true);
    expect(before.listing.price).toBe(900);

    await updateListing({
      storeId: storeAId,
      listingId: before.listing.id,
      price: 950,
      actor,
    });
    const priced = await variantOf({ customName: `Price Only ${RUN}` });
    expect(priced.listing.price).toBe(950);
    expect(priced.variant.price).toBe(900);
    expect(priced.variant.weightG).toBe(100);
    expect(priced.variant.weightPlaceholder).toBe(true);
    expect(priced.variant.id).toBe(before.variant.id);

    const created = await createListing({
      storeId: storeAId,
      customName: `Created ${RUN}`,
      price: 400,
      stockMode: "status",
      status: "in_stock",
      frozen: false,
      perishable: false,
      variants: [{ label: "Bag", price: 400, weightG: 100 }],
      actor,
    });
    const createdRow = await storeScoped(storeAId).listingVariant.findFirstOrThrow({
      where: { listingId: created.id },
    });
    expect(createdRow.weightG).toBe(100);
    expect(createdRow.weightPlaceholder).toBe(false);
    expect(createdRow.price).toBe(400);

    await updateListing({
      storeId: storeAId,
      listingId: priced.listing.id,
      variants: [{
        id: priced.variant.id,
        label: priced.variant.label,
        price: priced.variant.price,
        weightG: 22680,
      }],
      actor,
    });
    const cleared = await variantOf({ customName: `Price Only ${RUN}` });
    expect(cleared.variant.id).toBe(priced.variant.id);
    expect(cleared.variant.weightG).toBe(22680);
    expect(cleared.variant.weightPlaceholder).toBe(false);
    expect(cleared.variant.price).toBe(900);
    expect(cleared.listing.price).toBe(950);

    const again = await generatePreview(storeBId, `name,price\nVariants Only ${RUN},3.50\n`, userId);
    const second = await commitImport(
      storeBId,
      again.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    const secondListing = await storeScoped(storeBId).listing.findUniqueOrThrow({
      where: { id: second.listingIds[0] },
      include: { variants: true },
    });
    expect(secondListing.variants[0]?.weightPlaceholder).toBe(true);
    await updateVariants({
      storeId: storeBId,
      listingId: secondListing.id,
      variants: [{
        id: secondListing.variants[0]!.id,
        label: "Default",
        price: secondListing.variants[0]!.price,
        weightG: 500,
      }],
      actor,
    });
    const updated = await storeScoped(storeBId).listingVariant.findUniqueOrThrow({
      where: { id: secondListing.variants[0]!.id },
    });
    expect(updated.weightG).toBe(500);
    expect(updated.weightPlaceholder).toBe(false);
    expect(updated.price).toBe(350);
    expect(secondListing.price).toBe(350);
  });

  it("skipped and duplicate rows do not count toward needsWeightCount", async () => {
    const listed = `Listed Custom ${RUN}`;
    const first = await generatePreview(storeAId, `name,price\n${listed},1.10\n`, userId);
    const created = await commitImport(
      storeAId,
      first.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    expect(created.needsWeightCount).toBe(1);

    const dup = `Dup Custom ${RUN}`;
    const second = await generatePreview(
      storeAId,
      `name,price\n${listed},1.10\n${dup},2.20\n${dup},2.20\n`,
      userId,
    );
    const result = await commitImport(
      storeAId,
      second.importToken,
      { matchedRows: [], newItemRows: [2, 3, 4], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1);
    expect(result.needsWeightCount).toBe(1);
    const copies = await storeScoped(storeAId).listing.findMany({
      where: { customName: dup },
      include: { variants: true },
    });
    expect(copies).toHaveLength(1);
    expect(copies[0]?.variants[0]?.weightPlaceholder).toBe(true);
    expect(copies[0]?.variants[0]?.weightG).toBe(100);
    const stillListed = await storeScoped(storeAId).listing.findMany({ where: { customName: listed } });
    expect(stillListed).toHaveLength(1);
    const audits = await storeScoped(storeAId).auditLog.findMany({ where: { action: "catalog.csv_import" } });
    const entry = audits.find((row) => (row.after as { importId?: string } | null)?.importId === second.importToken);
    expect(entry?.after).toMatchObject({ needsWeightCount: 1, alreadyListedSkipped: 1, duplicatesSkipped: 1, count: 1 });
  });

  it("a failed commit writes no flags and a concurrent double commit flags once", async () => {
    const name = `Once ${RUN}`;
    const preview = await generatePreview(storeAId, `name,price\n${name},1.50\n`, userId);
    const selection = { matchedRows: [] as number[], newItemRows: [2], ambiguousResolutions: [] as Array<{ row: number; masterProductId: string }> };
    const settled = await Promise.allSettled([
      commitImport(storeAId, preview.importToken, selection, actor),
      commitImport(storeAId, preview.importToken, selection, actor),
    ]);
    const ok = settled.filter((row) => row.status === "fulfilled");
    const bad = settled.filter((row) => row.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0] as PromiseRejectedResult).reason.message).toBe("This import has already been committed.");
    expect((ok[0] as PromiseFulfilledResult<{ needsWeightCount: number }>).value.needsWeightCount).toBe(1);
    const listings = await storeScoped(storeAId).listing.findMany({
      where: { customName: name },
      include: { variants: true },
    });
    expect(listings).toHaveLength(1);
    expect(listings[0]?.variants).toHaveLength(1);
    expect(listings[0]?.variants[0]?.weightPlaceholder).toBe(true);

    const retryName = `Rollback ${RUN}`;
    const again = await generatePreview(storeBId, `name,price\n${retryName},2.00\n`, userId);
    const retrySelection = { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] };
    const missing: Actor = { id: `missing-${RUN}`, email: "missing@example.com" };
    await expect(commitImport(storeBId, again.importToken, retrySelection, missing)).rejects.toThrow();
    const none = await storeScoped(storeBId).listing.findMany({
      where: { customName: retryName },
      include: { variants: true },
    });
    expect(none).toEqual([]);
    const pending = await storeScoped(storeBId).listingImport.findUnique({ where: { id: again.importToken } });
    expect(pending?.status).toBe("pending");
    const retried = await commitImport(storeBId, again.importToken, retrySelection, actor);
    expect(retried.needsWeightCount).toBe(1);
    const stored = await storeScoped(storeBId).listing.findFirstOrThrow({
      where: { customName: retryName },
      include: { variants: true },
    });
    expect(stored.variants[0]?.weightG).toBe(100);
    expect(stored.variants[0]?.weightPlaceholder).toBe(true);
  });

  it("an import where no row needs a weight has needsWeightCount 0", async () => {
    const preview = await generatePreview(
      storeBId,
      `name,price,weight\nReal Weight ${RUN},3.00,500 g\n`,
      userId,
    );
    const result = await commitImport(
      storeBId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    expect(result.needsWeightCount).toBe(0);
    expect(result.createdCount).toBe(1);
    const stored = await storeScoped(storeBId).listing.findFirstOrThrow({
      where: { customName: `Real Weight ${RUN}` },
      include: { variants: true },
    });
    expect(stored.variants[0]?.weightG).toBe(500);
    expect(stored.variants[0]?.weightPlaceholder).toBe(false);
  });

  it("an owner save during an import commit leaves both consistent", async () => {
    const preview = await generatePreview(storeAId, `name,price\nHold X ${RUN},4.00\n`, userId);
    const created = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    expect(created.needsWeightCount).toBe(1);
    const before = await storeScoped(storeAId).listing.findFirstOrThrow({
      where: { customName: `Hold X ${RUN}` },
      include: { variants: true },
    });
    const variant = before.variants[0]!;
    expect(variant.weightPlaceholder).toBe(true);
    const other = await generatePreview(storeAId, `name,price\nHold Other ${RUN},5.00\n`, userId);
    const client = new Client({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM stores WHERE id = $1 FOR UPDATE", [storeAId]);
      const importing = commitImport(
        storeAId,
        other.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      );
      await new Promise((resolve) => setTimeout(resolve, 750));
      const saving = updateListing({
        storeId: storeAId,
        listingId: before.id,
        variants: [{ id: variant.id, label: variant.label, price: variant.price, weightG: 500 }],
        actor,
      });
      await new Promise((resolve) => setTimeout(resolve, 750));
      await client.query("COMMIT");
      const [imported] = await Promise.all([importing, saving]);
      expect(imported.needsWeightCount).toBe(1);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
    const after = await storeScoped(storeAId).listingVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(after.weightG).toBe(500);
    expect(after.weightPlaceholder).toBe(false);
    expect(after.price).toBe(400);
    const listing = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: before.id } });
    expect(listing.price).toBe(400);
    const extra = await storeScoped(storeAId).listing.findFirstOrThrow({
      where: { customName: `Hold Other ${RUN}` },
      include: { variants: true },
    });
    expect(extra.variants[0]?.weightPlaceholder).toBe(true);
    expect(extra.variants[0]?.weightG).toBe(100);
    expect(extra.price).toBe(500);
  }, 30_000);

  it("storeScoped(storeB) cannot read, clear, delete or create store A's placeholder variants or touch its import audit", async () => {
    const preview = await generatePreview(storeAId, `name,price\nIsolated ${RUN},9.00\n`, userId);
    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    const stored = await storeScoped(storeAId).listing.findFirstOrThrow({
      where: { id: result.listingIds[0] },
      include: { variants: true },
    });
    const variantId = stored.variants[0]!.id;
    expect(stored.variants[0]?.weightPlaceholder).toBe(true);

    const hidden = await storeScoped(storeBId).listingVariant.findMany({ where: { id: variantId } });
    expect(hidden).toEqual([]);
    const cleared = await storeScoped(storeBId).listingVariant.updateMany({
      where: { id: variantId },
      data: { weightPlaceholder: false },
    });
    const deleted = await storeScoped(storeBId).listingVariant.deleteMany({ where: { id: variantId } });
    expect(cleared.count).toBe(0);
    expect(deleted.count).toBe(0);
    await expect(
      storeScoped(storeBId).listingVariant.create({
        data: { listingId: stored.id, label: "Nope", price: 1, weightG: 100, weightPlaceholder: true },
      }),
    ).rejects.toThrow(/42501|row-level security/i);

    const audits = await storeScoped(storeAId).auditLog.findMany({ where: { action: "catalog.csv_import" } });
    const audit = audits.find((row) => (row.after as { importId?: string } | null)?.importId === preview.importToken);
    expect(audit).toBeTruthy();
    const hiddenAudit = await storeScoped(storeBId).auditLog.findMany({ where: { id: audit!.id } });
    expect(hiddenAudit).toEqual([]);
    const auditUpdate = await storeScoped(storeBId).auditLog.updateMany({
      where: { id: audit!.id },
      data: { actorEmail: "stolen@example.com" },
    });
    const auditDelete = await storeScoped(storeBId).auditLog.deleteMany({ where: { id: audit!.id } });
    expect(auditUpdate.count).toBe(0);
    expect(auditDelete.count).toBe(0);

    const still = await storeScoped(storeAId).listingVariant.findUniqueOrThrow({ where: { id: variantId } });
    expect(still.weightPlaceholder).toBe(true);
    expect(still.weightG).toBe(100);
    expect(still.price).toBe(900);
    const auditStill = await storeScoped(storeAId).auditLog.findUniqueOrThrow({ where: { id: audit!.id } });
    expect(auditStill.actorEmail).toBe(actor.email);
    expect(auditStill.after).toMatchObject({ needsWeightCount: 1 });
  });

  it("storefront and cart payloads for a placeholder listing carry no weightPlaceholder", async () => {
    const name = `Payload Yam ${RUN}`;
    const preview = await generatePreview(storeAId, `name,price\n${name},8.00\n`, userId);
    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    const listingId = result.listingIds[0]!;
    const variant = await storeScoped(storeAId).listingVariant.findFirstOrThrow({ where: { listingId } });
    expect(variant.weightPlaceholder).toBe(true);

    const [listings, detail, catalog] = await Promise.all([
      getActiveListings(storeAId),
      getListingDetail(storeAId, listingId),
      getFlowCatalog(storeAId),
    ]);
    const cartId = await getOrCreateCart(storeAId, null, null);
    await addLine(storeAId, cartId, variant.id, 1);
    const cart = await getCartWithLines(storeAId, cartId);
    const shown = listings.find((row) => row.id === listingId);
    const item = catalog.find((row) => row.listingId === listingId);
    expect(shown?.weightG).toBe(100);
    expect(detail?.variants).toEqual([
      { id: variant.id, label: "Default", price: 800, weightG: 100 },
    ]);
    expect(item).toMatchObject({ variantId: variant.id, price: 800, weightG: 100 });
    expect(cart?.lines[0]?.variant.weightG).toBe(100);
    expect(JSON.stringify({ listings, detail, catalog, cart })).not.toContain("weightPlaceholder");
  });

  it("a placeholder flag does not depend on the clock", async () => {
    const name = `Night ${RUN}`;
    const preview = await generatePreview(storeAId, `name,price\n${name},1.25\n`, userId);
    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
    await storeScoped(storeAId).listing.update({
      where: { id: result.listingIds[0] },
      data: { createdAt: yesterday },
    });
    const row = await storeScoped(storeAId).listingVariant.findFirstOrThrow({
      where: { listingId: result.listingIds[0] },
    });
    expect(row.weightPlaceholder).toBe(true);
    expect(row.weightG).toBe(100);
    expect(row.price).toBe(125);
  });

  it("5000 custom rows without weight commit with needsWeightCount 5000", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `Max216 ${RUN} ${i},1.00`);
    const csv = `name,price\n${lines.join("\n")}\n`;
    const preview = await generatePreview(storeBId, csv, userId);
    expect(preview.newItems).toHaveLength(5000);
    const result = await commitImport(
      storeBId,
      preview.importToken,
      { matchedRows: [], newItemRows: preview.newItems.map((row) => row.row), ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(5000);
    expect(result.needsWeightCount).toBe(5000);
    const sample = await storeScoped(storeBId).listing.findFirstOrThrow({
      where: { customName: `Max216 ${RUN} 0` },
      include: { variants: true },
    });
    expect(sample.variants[0]?.weightPlaceholder).toBe(true);
    expect(sample.variants[0]?.weightG).toBe(100);
    expect(sample.price).toBe(100);
  }, 120_000);

  it("seed re-run leaves demo variants false", async () => {
    const store = await raw.store.findUniqueOrThrow({ where: { slug: "mama-ngozi" } });
    await seedDemoCatalog(raw);
    await seedDemoCatalog(raw);
    const variant = await storeScoped(store.id).listingVariant.findUniqueOrThrow({
      where: { id: "mn_yam_v1" },
    });
    expect(variant.weightPlaceholder).toBe(false);
    expect(variant.weightG).toBe(907);
    expect(variant.price).toBe(899);
  }, 180_000);

  it("runs as app_runtime and production runtime url throws without APP_RUNTIME_PASSWORD", async () => {
    const rows = (await healthQueryRaw`SELECT current_user`) as Array<{ current_user: string }>;
    expect(rows[0]?.current_user).toBe("app_runtime");
    expect(hasDb).toBe(true);
    expect(() =>
      runtimeDatabaseUrl({
        DATABASE_URL: "postgresql://owner:secret@localhost:5434/lane_t216",
        NODE_ENV: "production",
      }),
    ).toThrow(/APP_RUNTIME_PASSWORD is required/);
  });
});
