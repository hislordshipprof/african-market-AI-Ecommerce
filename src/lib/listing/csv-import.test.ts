import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  parseCsvText,
  parsePriceToCents,
  generatePreview,
  commitImport,
  createImportToken,
  getImportTokenData,
  markImportTokenUsed,
  validateFileSize,
  MAX_FILE_BYTES,
  MAX_NAME_LENGTH,
} from "./csv-import";
import { storeScoped, platformAdmin } from "../db";
import type { Actor } from "./service";

describe("parsePriceToCents", () => {
  it("parses simple integer", () => {
    expect(parsePriceToCents("12")).toBe(1200);
  });
  it("parses decimal with two places", () => {
    expect(parsePriceToCents("3.50")).toBe(350);
  });
  it("parses dollar sign prefix", () => {
    expect(parsePriceToCents("$1,234.50")).toBe(123450);
  });
  it("parses single decimal place", () => {
    expect(parsePriceToCents("3.5")).toBe(350);
  });
  it("rejects more than two decimal places (E3)", () => {
    expect(parsePriceToCents("3.505")).toBeNull();
  });
  it("returns negative for negative price", () => {
    expect(parsePriceToCents("-2")).toBe(-200);
  });
  it("returns 0 for zero", () => {
    expect(parsePriceToCents("0")).toBe(0);
  });
  it("returns null for empty string", () => {
    expect(parsePriceToCents("")).toBeNull();
  });
  it("returns null for non-numeric", () => {
    expect(parsePriceToCents("abc")).toBeNull();
  });
  it("handles $ with space", () => {
    expect(parsePriceToCents("$ 5.99")).toBe(599);
  });
});

describe("parseCsvText", () => {
  it("parses a simple CSV", () => {
    const csv = "name,price\nEgusi,12.50\nPalm Oil,8.99\n";
    const { rows, errors } = parseCsvText(csv);
    expect(rows).toHaveLength(2);
    expect(errors).toHaveLength(0);
    expect(rows[0].name).toBe("Egusi");
    expect(rows[0].price).toBe(1250);
    expect(rows[1].name).toBe("Palm Oil");
    expect(rows[1].price).toBe(899);
  });

  it("E1: handles UTF-8 BOM and CRLF line endings", () => {
    const bom = "﻿";
    const csv = `${bom}name,price\r\nEgusi,12.50\r\n`;
    const { rows, errors } = parseCsvText(csv);
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(rows[0].name).toBe("Egusi");
  });

  it("E1: handles quoted fields with commas and newlines", () => {
    const csv = `name,price\n"Egusi, ground",12.50\n"Palm\nOil",8.99\n`;
    const { rows, errors } = parseCsvText(csv);
    expect(rows).toHaveLength(2);
    expect(errors).toHaveLength(0);
    expect(rows[0].name).toBe("Egusi, ground");
  });

  it("E2: handles header case/whitespace variants and extra columns", () => {
    const csv = " Name , Price ,Extra Column\nEgusi,12.50,ignored\n";
    const { rows, errors, unknownColumns } = parseCsvText(csv);
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(unknownColumns).toContain("Extra Column");
  });

  it("E2: handles reordered columns", () => {
    const csv = "price,name\n12.50,Egusi\n";
    const { rows, errors } = parseCsvText(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Egusi");
    expect(rows[0].price).toBe(1250);
  });

  it("E3: rejects price with more than 2 decimals", () => {
    const csv = "name,price\nEgusi,3.505\n";
    const { rows, errors } = parseCsvText(csv);
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("Invalid price");
  });

  it("E3: rejects negative price", () => {
    const csv = "name,price\nEgusi,-2\n";
    const { rows, errors } = parseCsvText(csv);
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("negative");
  });

  it("E3: rejects zero price", () => {
    const csv = "name,price\nEgusi,0\n";
    const { rows, errors } = parseCsvText(csv);
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("zero");
  });

  it("E3: parses $1,234.50 format", () => {
    const csv = 'name,price\nEgusi,"$1,234.50"\n';
    const { rows } = parseCsvText(csv);
    expect(rows[0].price).toBe(123450);
  });

  it("E4: empty file", () => {
    const { errors } = parseCsvText("");
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("empty");
  });

  it("E4: header-only file", () => {
    const { errors } = parseCsvText("name,price\n");
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("empty");
  });

  it("E5: binary/non-CSV data", () => {
    const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]).toString();
    const { errors } = parseCsvText(binary);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("missing name in a row", () => {
    const csv = "name,price\n,12.50\n";
    const { errors } = parseCsvText(csv);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("name");
  });

  it("E3: missing price in a row", () => {
    const csv = "name,price\nEgusi,\n";
    const { errors } = parseCsvText(csv);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("price");
  });

  it("E3: non-numeric price", () => {
    const csv = "name,price\nEgusi,abc\n";
    const { errors } = parseCsvText(csv);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("Invalid price");
  });

  it("E15: rejects names over 200 characters", () => {
    const longName = "A".repeat(201);
    const csv = `name,price\n${longName},12.50\n`;
    const { errors } = parseCsvText(csv);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("200 characters");
  });

  it("E15: rejects control characters in name", () => {
    const csv = "name,price\nEgusi\x07,12.50\n";
    const { errors } = parseCsvText(csv);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("control characters");
  });

  it("parses optional stock columns", () => {
    const csv = "name,price,stock_mode,qty,status\nEgusi,12.50,counted,25,\nPalm Oil,8.99,status,,in_stock\n";
    const { rows } = parseCsvText(csv);
    expect(rows[0].stockMode).toBe("counted");
    expect(rows[0].qty).toBe(25);
    expect(rows[1].stockMode).toBe("status");
    expect(rows[1].status).toBe("in_stock");
  });

  it("missing name column in headers", () => {
    const csv = "product,price\nEgusi,12.50\n";
    const { errors } = parseCsvText(csv);
    expect(errors[0].reason).toContain("Missing required column: name");
  });

  it("missing price column in headers", () => {
    const csv = "name,cost\nEgusi,12.50\n";
    const { errors } = parseCsvText(csv);
    expect(errors[0].reason).toContain("Missing required column: price");
  });
});

describe("validateFileSize", () => {
  it("returns null for small files", () => {
    expect(validateFileSize(1024)).toBeNull();
  });
  it("returns error for files over 2 MB", () => {
    expect(validateFileSize(MAX_FILE_BYTES + 1)).toBeTruthy();
  });
});

describe("import token", () => {
  it("creates and retrieves a token", () => {
    const token = createImportToken("store-a", "csv data");
    const data = getImportTokenData(token, "store-a");
    expect(data).toBeTruthy();
    expect(data!.csvText).toBe("csv data");
  });

  it("rejects token from wrong store (E12)", () => {
    const token = createImportToken("store-a", "csv data");
    const data = getImportTokenData(token, "store-b");
    expect(data).toBeNull();
  });

  it("E11: rejects already-used token (double submit)", () => {
    const token = createImportToken("store-a", "csv data");
    markImportTokenUsed(token);
    const data = getImportTokenData(token, "store-a");
    expect(data).toBeNull();
  });

  it("rejects nonexistent token", () => {
    expect(getImportTokenData("nonexistent", "store-a")).toBeNull();
  });
});

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("generatePreview (DB integration)", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;
  let testUserId: string;
  const mpIds: string[] = [];

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const storeA = await rawPrisma.store.upsert({
      where: { slug: "csv-import-test-a" },
      update: {},
      create: { slug: "csv-import-test-a", name: "CSV Import Store A", themePreset: "palm-and-shea" },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.upsert({
      where: { slug: "csv-import-test-b" },
      update: {},
      create: { slug: "csv-import-test-b", name: "CSV Import Store B", themePreset: "lagoon-and-coral" },
    });
    storeBId = storeB.id;

    const user = await rawPrisma.user.upsert({
      where: { email: "csv-import-test@example.com" },
      update: {},
      create: { id: "csv-import-user", email: "csv-import-test@example.com", name: "CSV Test User", emailVerified: true },
    });
    testUserId = user.id;

    const mp1 = await platformAdmin.masterProduct.create({
      data: { name: "Zola Citrus Oil T63", frozen: false, perishable: false },
    });
    mpIds.push(mp1.id);

    const mp2 = await platformAdmin.masterProduct.create({
      data: { name: "Bimba Seed Flour T63", frozen: false, perishable: false },
    });
    mpIds.push(mp2.id);

    await platformAdmin.productSynonym.create({
      data: { productId: mp2.id, term: "Bimba Seeds T63" },
    });
    await platformAdmin.productSynonym.create({
      data: { productId: mp2.id, term: "bimba ground t63" },
    });

    // Create existing listing in store A for Zola Citrus Oil to test E7
    const scopedA = storeScoped(storeAId);
    await scopedA.listing.create({
      data: {
        storeId: storeAId,
        masterProductId: mp1.id,
        price: 999,
        stockMode: "status",
        status: "in_stock",
      },
    });
  });

  afterAll(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.auditLog.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
      rawPrisma.stockEvent.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
      rawPrisma.listingVariant.deleteMany({ where: { listing: { storeId: { in: [storeAId, storeBId] } } } }),
      rawPrisma.listing.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
    await rawPrisma.productSynonym.deleteMany({ where: { productId: { in: mpIds } } });
    await rawPrisma.masterProduct.deleteMany({ where: { id: { in: mpIds } } });
    await rawPrisma.user.deleteMany({ where: { email: "csv-import-test@example.com" } });
    await rawPrisma.store.deleteMany({ where: { slug: { in: ["csv-import-test-a", "csv-import-test-b"] } } });
    await rawPrisma.$disconnect();
  });

  it("AC2: matches exact name (Zola Citrus Oil T63)", async () => {
    const csv = "name,price\nZola Citrus Oil T63,8.99\n";
    const preview = await generatePreview(storeAId, csv);
    // Zola Citrus Oil already listed in store A, so it should be in alreadyListed
    expect(preview.alreadyListed).toHaveLength(1);
    expect(preview.alreadyListed[0].masterProductName).toBe("Zola Citrus Oil T63");
  });

  it("AC2: matches via synonym (Bimba Seeds T63)", async () => {
    const csv = "name,price\nBimba Seeds T63,12.50\n";
    const preview = await generatePreview(storeAId, csv);
    expect(preview.matches).toHaveLength(1);
    expect(preview.matches[0].matchType).toBe("synonym");
    expect(preview.matches[0].masterProductName).toBe("Bimba Seed Flour T63");
  });

  it("AC2: no match creates new item", async () => {
    const csv = "name,price\nMagic Spice Blend,5.99\n";
    const preview = await generatePreview(storeAId, csv);
    expect(preview.newItems).toHaveLength(1);
    expect(preview.newItems[0].csvName).toBe("Magic Spice Blend");
  });

  it("E7: already listed product shown as 'already listed'", async () => {
    const csv = "name,price\nZola Citrus Oil T63,10.99\n";
    const preview = await generatePreview(storeAId, csv);
    expect(preview.alreadyListed).toHaveLength(1);
    expect(preview.alreadyListed[0].csvName).toBe("Zola Citrus Oil T63");
  });

  it("E6: duplicate rows flagged", async () => {
    const csv = "name,price\nBimba Seeds T63,12.50\nBimba Seeds T63,15.00\n";
    const preview = await generatePreview(storeAId, csv);
    expect(preview.duplicates).toHaveLength(1);
    expect(preview.duplicates[0].csvName).toBe("Bimba Seeds T63");
    expect(preview.duplicates[0].firstRow).toBe(2);
  });

  it("E9: unicode and accented names (Bimba vs Bîmba)", async () => {
    const csv = "name,price\nBîmba Seeds T63,12.50\n";
    const preview = await generatePreview(storeAId, csv);
    expect(preview.matches).toHaveLength(1);
    expect(preview.matches[0].matchType).toBe("synonym");
  });

  it("E9: leading/trailing spaces trimmed for matching", async () => {
    const csv = "name,price\n  Bimba Seeds T63  ,12.50\n";
    const preview = await generatePreview(storeAId, csv);
    expect(preview.matches).toHaveLength(1);
  });

  it("returns import token", async () => {
    const csv = "name,price\nBimba Seeds T63,12.50\n";
    const preview = await generatePreview(storeAId, csv);
    expect(preview.importToken).toBeTruthy();
  });

  it("E13: commit with zero selected rows", async () => {
    const csv = "name,price\nBimba Seeds T63,12.50\n";
    const preview = await generatePreview(storeAId, csv);
    const actor: Actor = { id: testUserId, email: "csv-import-test@example.com" };
    await expect(
      commitImport(storeAId, preview.importToken, {
        matchedRows: [],
        newItemRows: [],
        duplicateRows: [],
        ambiguousResolutions: [],
      }, actor),
    ).rejects.toThrow(/No rows selected/);
  });
});

describe.skipIf(!hasDb)("commitImport (DB integration)", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;
  let testUserId: string;
  let actor: Actor;
  const mpIds: string[] = [];

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const storeA = await rawPrisma.store.upsert({
      where: { slug: "csv-commit-test-a" },
      update: {},
      create: { slug: "csv-commit-test-a", name: "CSV Commit A", themePreset: "palm-and-shea" },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.upsert({
      where: { slug: "csv-commit-test-b" },
      update: {},
      create: { slug: "csv-commit-test-b", name: "CSV Commit B", themePreset: "lagoon-and-coral" },
    });
    storeBId = storeB.id;

    const user = await rawPrisma.user.upsert({
      where: { email: "csv-commit-test@example.com" },
      update: {},
      create: { id: "csv-commit-user", email: "csv-commit-test@example.com", name: "CSV Commit User", emailVerified: true },
    });
    testUserId = user.id;
    actor = { id: user.id, email: user.email };

    const mp = await platformAdmin.masterProduct.create({
      data: { name: "Kundi Flour T63", frozen: false, perishable: true },
    });
    mpIds.push(mp.id);

    await platformAdmin.productSynonym.create({
      data: { productId: mp.id, term: "kundi t63" },
    });
  });

  afterAll(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.auditLog.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
      rawPrisma.stockEvent.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
      rawPrisma.listingVariant.deleteMany({ where: { listing: { storeId: { in: [storeAId, storeBId] } } } }),
      rawPrisma.listing.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
    await rawPrisma.productSynonym.deleteMany({ where: { productId: { in: mpIds } } });
    await rawPrisma.masterProduct.deleteMany({ where: { id: { in: mpIds } } });
    await rawPrisma.user.deleteMany({ where: { email: "csv-commit-test@example.com" } });
    await rawPrisma.store.deleteMany({ where: { slug: { in: ["csv-commit-test-a", "csv-commit-test-b"] } } });
    await rawPrisma.$disconnect();
  });

  it("AC3: creates matched listing in the correct store", async () => {
    const csv = "name,price\nKundi T63,6.99\n";
    const preview = await generatePreview(storeAId, csv);
    expect(preview.matches).toHaveLength(1);

    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [2], newItemRows: [], duplicateRows: [], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1);

    const scopedA = storeScoped(storeAId);
    const listings = await scopedA.listing.findMany({ where: { id: { in: result.listingIds } } });
    expect(listings).toHaveLength(1);
    expect(listings[0].masterProductId).toBe(mpIds[0]);
    expect(listings[0].perishable).toBe(true);
    expect(listings[0].price).toBe(699);
  });

  it("AC3: creates custom listing for new items", async () => {
    const csv = "name,price\nMy Custom Item,15.00\n";
    const preview = await generatePreview(storeAId, csv);
    expect(preview.newItems).toHaveLength(1);

    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], duplicateRows: [], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1);

    const scopedA = storeScoped(storeAId);
    const listings = await scopedA.listing.findMany({ where: { id: { in: result.listingIds } } });
    expect(listings[0].masterProductId).toBeNull();
    expect(listings[0].customName).toBe("My Custom Item");
  });

  it("AC3: creates audit log for import", async () => {
    const csv = "name,price\nAnother Custom,9.99\n";
    const preview = await generatePreview(storeAId, csv);
    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], duplicateRows: [], ambiguousResolutions: [] },
      actor,
    );

    const scopedA = storeScoped(storeAId);
    const logs = await scopedA.auditLog.findMany({
      where: { action: "catalog.csv_import" },
      orderBy: { createdAt: "desc" },
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect((logs[0].after as Record<string, unknown>).count).toBe(1);
  });

  it("store isolation: store B cannot see store A imports", async () => {
    const csv = "name,price\nStore A Only Item T63,7.50\n";
    const preview = await generatePreview(storeAId, csv);
    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], duplicateRows: [], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1);

    const scopedB = storeScoped(storeBId);
    const bListings = await scopedB.listing.findMany();
    const importedIds = new Set(result.listingIds);
    expect(bListings.filter((l) => importedIds.has(l.id))).toHaveLength(0);
  });

  it("store isolation: audit log isolated", async () => {
    const scopedB = storeScoped(storeBId);
    const logs = await scopedB.auditLog.findMany({
      where: { action: "catalog.csv_import" },
    });
    expect(logs.every((l) => l.storeId === storeBId)).toBe(true);
  });

  it("E11: double submit with same token fails", async () => {
    const csv = "name,price\nDouble Submit T63,5.00\n";
    const preview = await generatePreview(storeAId, csv);

    await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], duplicateRows: [], ambiguousResolutions: [] },
      actor,
    );

    await expect(
      commitImport(
        storeAId,
        preview.importToken,
        { matchedRows: [], newItemRows: [2], duplicateRows: [], ambiguousResolutions: [] },
        actor,
      ),
    ).rejects.toThrow(/invalid|expired|already used/i);
  });

  it("E10: formula injection stored as plain text", async () => {
    const csv = `name,price\n"=HYPERLINK(""http://evil.com"")Attack",5.00\n`;
    const preview = await generatePreview(storeAId, csv);
    expect(preview.newItems).toHaveLength(1);

    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], duplicateRows: [], ambiguousResolutions: [] },
      actor,
    );

    const scopedA = storeScoped(storeAId);
    const listing = await scopedA.listing.findUnique({ where: { id: result.listingIds[0] } });
    expect(listing!.customName).toContain("'=");
  });
});
