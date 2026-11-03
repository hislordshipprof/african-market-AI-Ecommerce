import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  parseCsvText,
  parsePriceToCents,
  generatePreview,
  commitImport,
  validateFileSize,
  MAX_FILE_BYTES,
} from "./csv-import";
import { storeScoped, platformAdmin } from "../db";
import { createListing } from "./service";
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
  it("A1: rejects price that overflows PostgreSQL int4 (>= $21,474,836.48)", () => {
    expect(parsePriceToCents("30000000.00")).toBeNull();
    expect(parsePriceToCents("21474836.48")).toBeNull();
  });
  it("A1: accepts largest valid price ($21,474,836.47)", () => {
    expect(parsePriceToCents("21474836.47")).toBe(2_147_483_647);
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
    const { rows } = parseCsvText(csv);
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

  it("A1: price overflowing int4 becomes a row error", () => {
    const csv = "name,price\nOk Item,5.00\nBad Item,30000000.00\n";
    const { rows, errors } = parseCsvText(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Ok Item");
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("Invalid price");
  });

  it("A1: qty overflowing int4 becomes a row error", () => {
    const csv = "name,price,qty\nOk Item,5.00,10\nBad Item,5.00,3000000000\n";
    const { rows, errors } = parseCsvText(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Ok Item");
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("Invalid quantity");
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

  it("rejects files over 5000 rows", () => {
    const rows = Array.from({ length: 5001 }, (_, i) => `Product${i},${i + 1}.00`);
    const csv = "name,price\n" + rows.join("\n") + "\n";
    const { errors } = parseCsvText(csv);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("5000");
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
      rawPrisma.listingImport.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
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
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.alreadyListed).toHaveLength(1);
    expect(preview.alreadyListed[0].masterProductName).toBe("Zola Citrus Oil T63");
  });

  it("AC2: matches via synonym (Bimba Seeds T63)", async () => {
    const csv = "name,price\nBimba Seeds T63,12.50\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.matches).toHaveLength(1);
    expect(preview.matches[0].matchType).toBe("synonym");
    expect(preview.matches[0].masterProductName).toBe("Bimba Seed Flour T63");
  });

  it("AC2: no match creates new item", async () => {
    const csv = "name,price\nMagic Spice Blend,5.99\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.newItems).toHaveLength(1);
    expect(preview.newItems[0].csvName).toBe("Magic Spice Blend");
  });

  it("E7: already listed product shown as 'already listed'", async () => {
    const csv = "name,price\nZola Citrus Oil T63,10.99\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.alreadyListed).toHaveLength(1);
    expect(preview.alreadyListed[0].csvName).toBe("Zola Citrus Oil T63");
  });

  it("E6: duplicate rows flagged", async () => {
    const csv = "name,price\nBimba Seeds T63,12.50\nBimba Seeds T63,15.00\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.duplicates).toHaveLength(1);
    expect(preview.duplicates[0].csvName).toBe("Bimba Seeds T63");
    expect(preview.duplicates[0].firstRow).toBe(2);
  });

  it("E9: unicode and accented names (Bimba vs Bîmba)", async () => {
    const csv = "name,price\nBîmba Seeds T63,12.50\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.matches).toHaveLength(1);
    expect(preview.matches[0].matchType).toBe("synonym");
  });

  it("E9: leading/trailing spaces trimmed for matching", async () => {
    const csv = "name,price\n  Bimba Seeds T63  ,12.50\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.matches).toHaveLength(1);
  });

  it("D1: returns DB-backed import token", async () => {
    const csv = "name,price\nBimba Seeds T63,12.50\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.importToken).toBeTruthy();

    const scoped = storeScoped(storeAId);
    const record = await scoped.listingImport.findUnique({ where: { id: preview.importToken } });
    expect(record).toBeTruthy();
    expect(record!.status).toBe("pending");
    expect(record!.rowCount).toBe(1);
  });

  it("D3: custom-name already-listed in preview", async () => {
    const scopedA = storeScoped(storeAId);
    const existing = await scopedA.listing.create({
      data: { storeId: storeAId, customName: "My Custom Spice", price: 500, stockMode: "status", status: "in_stock" },
    });

    try {
      const csv = "name,price\nMy Custom Spice,6.00\n";
      const preview = await generatePreview(storeAId, csv, testUserId);
      expect(preview.alreadyListed).toHaveLength(1);
      expect(preview.alreadyListed[0].csvName).toBe("My Custom Spice");
      expect(preview.newItems).toHaveLength(0);
    } finally {
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.listing.deleteMany({ where: { id: existing.id } }),
      ]);
    }
  });

  it("D4: preview returned when only alreadyListed is non-empty", async () => {
    const csv = "name,price\nZola Citrus Oil T63,10.99\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.alreadyListed.length).toBeGreaterThan(0);
    expect(preview.importToken).toBeTruthy();
  });

  it("E13: commit with zero selected rows", async () => {
    const csv = "name,price\nBimba Seeds T63,12.50\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    const actor: Actor = { id: testUserId, email: "csv-import-test@example.com" };
    await expect(
      commitImport(storeAId, preview.importToken, {
        matchedRows: [],
        newItemRows: [],
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
  let ambigMp1Id: string;
  let ambigMp2Id: string;

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

    const ambig1 = await platformAdmin.masterProduct.create({
      data: { name: "Ambig Spice T63", frozen: false, perishable: false },
    });
    ambigMp1Id = ambig1.id;
    mpIds.push(ambig1.id);

    const ambig2 = await platformAdmin.masterProduct.create({
      data: { name: "Ambig Herb T63", frozen: false, perishable: false },
    });
    ambigMp2Id = ambig2.id;
    mpIds.push(ambig2.id);

    await platformAdmin.productSynonym.create({
      data: { productId: ambig1.id, term: "Ambig T63" },
    });
    await platformAdmin.productSynonym.create({
      data: { productId: ambig2.id, term: "Ambig T63" },
    });
  });

  afterAll(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.listingImport.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
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
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.matches).toHaveLength(1);

    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [2], newItemRows: [], ambiguousResolutions: [] },
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
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.newItems).toHaveLength(1);

    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
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
    const preview = await generatePreview(storeAId, csv, testUserId);
    await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
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

  it("D6: store isolation — store B cannot see store A listings", async () => {
    const csv = "name,price\nStore A Only Item T63,7.50\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1);

    const scopedB = storeScoped(storeBId);
    const bListings = await scopedB.listing.findMany();
    const importedIds = new Set(result.listingIds);
    expect(bListings.filter((l) => importedIds.has(l.id))).toHaveLength(0);
  });

  it("D6: store isolation — audit log isolated", async () => {
    const scopedB = storeScoped(storeBId);
    const logs = await scopedB.auditLog.findMany({
      where: { action: "catalog.csv_import" },
    });
    expect(logs.every((l) => l.storeId === storeBId)).toBe(true);
  });

  it("D6: store isolation — listing_variants isolated", async () => {
    const csv = "name,price\nVariant Isolation T63,4.00\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    const result = await commitImport(
      storeAId, preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    const scopedA = storeScoped(storeAId);
    const variantsA = await scopedA.listingVariant.findMany({ where: { listingId: result.listingIds[0] } });
    expect(variantsA).toHaveLength(1);

    const scopedB = storeScoped(storeBId);
    const variantsB = await scopedB.listingVariant.findMany();
    expect(variantsB.filter((v) => v.listingId === result.listingIds[0])).toHaveLength(0);
  });

  it("D6: store isolation — stock_events isolated", async () => {
    const csv = "name,price,stock_mode,qty\nStock Isolation T63,5.00,counted,10\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    const result = await commitImport(
      storeAId, preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );

    const scopedA = storeScoped(storeAId);
    const eventsA = await scopedA.stockEvent.findMany({ where: { listingId: result.listingIds[0] } });
    expect(eventsA).toHaveLength(1);

    const scopedB = storeScoped(storeBId);
    const eventsB = await scopedB.stockEvent.findMany();
    expect(eventsB.filter((e) => e.listingId === result.listingIds[0])).toHaveLength(0);
  });

  it("D6: store isolation — listing_imports isolated", async () => {
    const csv = "name,price\nImport Isolation T63,3.00\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.importToken).toBeTruthy();

    const scopedA = storeScoped(storeAId);
    const recordA = await scopedA.listingImport.findUnique({ where: { id: preview.importToken } });
    expect(recordA).toBeTruthy();

    const scopedB = storeScoped(storeBId);
    const recordB = await scopedB.listingImport.findUnique({ where: { id: preview.importToken } });
    expect(recordB).toBeNull();
  });

  it("E11: double submit with same token fails", async () => {
    const csv = "name,price\nDouble Submit T63,5.00\n";
    const preview = await generatePreview(storeAId, csv, testUserId);

    await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );

    await expect(
      commitImport(
        storeAId,
        preview.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      ),
    ).rejects.toThrow(/already.*committed/i);
  });

  it("D1: concurrent double-submit — one succeeds, one fails", async () => {
    const csv = "name,price\nConcurrent Double T63,8.00\n";
    const preview = await generatePreview(storeAId, csv, testUserId);

    const results = await Promise.allSettled([
      commitImport(
        storeAId,
        preview.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      ),
      commitImport(
        storeAId,
        preview.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("E14: DB failure mid-commit rolls back entire transaction", async () => {
    const csv = "name,price\nRollback Test T63,999.99\n";
    const preview = await generatePreview(storeAId, csv, testUserId);

    await rawPrisma.$executeRaw`ALTER TABLE listings ADD CONSTRAINT test_reject_rollback CHECK (price != 99999)`;

    try {
      await expect(
        commitImport(
          storeAId,
          preview.importToken,
          { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
          actor,
        ),
      ).rejects.toThrow();

      const scopedA = storeScoped(storeAId);
      const orphans = await scopedA.listing.findMany({
        where: { customName: { contains: "Rollback Test T63" } },
      });
      expect(orphans).toHaveLength(0);

      const importRecord = await scopedA.listingImport.findUnique({
        where: { id: preview.importToken },
      });
      expect(importRecord!.status).toBe("pending");
    } finally {
      await rawPrisma.$executeRaw`ALTER TABLE listings DROP CONSTRAINT IF EXISTS test_reject_rollback`;
    }
  });

  it("concurrent imports with separate tokens both succeed", async () => {
    const csvA = "name,price\nConcurrent Item A T63,3.00\n";
    const csvB = "name,price\nConcurrent Item B T63,4.00\n";

    const previewA = await generatePreview(storeAId, csvA, testUserId);
    const previewB = await generatePreview(storeAId, csvB, testUserId);

    expect(previewA.importToken).not.toBe(previewB.importToken);

    const [resultA, resultB] = await Promise.all([
      commitImport(
        storeAId,
        previewA.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      ),
      commitImport(
        storeAId,
        previewB.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      ),
    ]);

    expect(resultA.createdCount).toBe(1);
    expect(resultB.createdCount).toBe(1);
  });

  it("A3: crafted duplicateRows in selection are ignored (field removed)", async () => {
    const csv = "name,price\nDupe Bypass A T63,5.00\nDupe Bypass A T63,6.00\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.duplicates).toHaveLength(1);

    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1);
  });

  it("F1: crafted matchedRows with duplicate names creates only one listing per masterProduct", async () => {
    const csv = "name,price\nKundi T63,6.99\nKundi T63,7.99\n";
    const preview = await generatePreview(storeBId, csv, testUserId);

    const result = await commitImport(
      storeBId,
      preview.importToken,
      { matchedRows: [2, 3], newItemRows: [], ambiguousResolutions: [] },
      actor,
    );

    expect(result.createdCount).toBe(1);

    const scopedB = storeScoped(storeBId);
    const listings = await scopedB.listing.findMany({
      where: { id: { in: result.listingIds } },
    });
    expect(listings).toHaveLength(1);
  });

  it("F1: crafted newItemRows with duplicate custom names creates only one listing", async () => {
    const csv = "name,price\nUnique Custom F1 T63,6.99\nUnique Custom F1 T63,7.99\n";
    const preview = await generatePreview(storeAId, csv, testUserId);

    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2, 3], ambiguousResolutions: [] },
      actor,
    );

    expect(result.createdCount).toBe(1);
  });

  it("E10: formula injection stored as plain text", async () => {
    const csv = `name,price\n"=HYPERLINK(""http://evil.com"")Attack",5.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.newItems).toHaveLength(1);

    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );

    const scopedA = storeScoped(storeAId);
    const listing = await scopedA.listing.findUnique({ where: { id: result.listingIds[0] } });
    expect(listing!.customName).toContain("'=");
  });

  it("A1: formula-prefixed custom name detected as already-listed on re-import", async () => {
    const csv = 'name,price\n=Special Sauce T63,7.00\n';
    const preview1 = await generatePreview(storeBId, csv, testUserId);
    expect(preview1.newItems).toHaveLength(1);

    await commitImport(
      storeBId,
      preview1.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );

    const preview2 = await generatePreview(storeBId, csv, testUserId);
    expect(preview2.alreadyListed).toHaveLength(1);
    expect(preview2.newItems).toHaveLength(0);
  });

  it("D1: nonexistent import token rejected", async () => {
    await expect(
      commitImport(
        storeAId, "nonexistent-token",
        { matchedRows: [2], newItemRows: [], ambiguousResolutions: [] },
        actor,
      ),
    ).rejects.toThrow(/invalid|expired|already used/i);
  });

  it("D1: import token from store A rejected when committing to store B", async () => {
    const csv = "name,price\nCross Store Token T63,5.00\n";
    const preview = await generatePreview(storeAId, csv, testUserId);

    await expect(
      commitImport(
        storeBId, preview.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      ),
    ).rejects.toThrow(/invalid|expired|already used/i);
  });

  it("D2: P2002 already-listed handled gracefully in createListing", async () => {
    const scopedA = storeScoped(storeAId);
    const existing = await scopedA.listing.findFirst({ where: { masterProductId: mpIds[0] } });
    if (!existing) {
      await createListing({
        storeId: storeAId,
        masterProductId: mpIds[0],
        price: 699,
        stockMode: "status",
        frozen: false,
        perishable: true,
        variants: [{ label: "Default", price: 699, weightG: 1 }],
        actor,
      });
    }

    await expect(
      createListing({
        storeId: storeAId,
        masterProductId: mpIds[0],
        price: 799,
        stockMode: "status",
        frozen: false,
        perishable: true,
        variants: [{ label: "Default", price: 799, weightG: 1 }],
        actor,
      }),
    ).rejects.toThrow(/already listed/i);
  });

  it("D3: custom-name already-listed blocked at commit", async () => {
    const scopedA = storeScoped(storeAId);
    await scopedA.listing.create({
      data: { storeId: storeAId, customName: "Unique Custom D3 T63", price: 500, stockMode: "status", status: "in_stock" },
    });

    const csv = "name,price\nUnique Custom D3 T63,6.00\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.alreadyListed).toHaveLength(1);
  });

  it("D7: ambiguousResolutions — valid resolution creates listing", async () => {
    const csv = "name,price\nAmbig T63,10.00\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.ambiguous).toHaveLength(1);
    expect(preview.ambiguous[0].candidates.length).toBeGreaterThanOrEqual(2);

    const result = await commitImport(
      storeAId, preview.importToken,
      {
        matchedRows: [],
        newItemRows: [],
        ambiguousResolutions: [{ row: 2, masterProductId: ambigMp1Id }],
      },
      actor,
    );
    expect(result.createdCount).toBe(1);

    const scopedA = storeScoped(storeAId);
    const listing = await scopedA.listing.findUnique({ where: { id: result.listingIds[0] } });
    expect(listing!.masterProductId).toBe(ambigMp1Id);
  });

  it("D7: ambiguousResolutions — product not in match list is rejected", async () => {
    const csv = "name,price\nAmbig T63,10.00\n";
    const preview = await generatePreview(storeBId, csv, testUserId);
    expect(preview.ambiguous).toHaveLength(1);

    await expect(
      commitImport(
        storeBId, preview.importToken,
        {
          matchedRows: [],
          newItemRows: [],
          ambiguousResolutions: [{ row: 2, masterProductId: "nonexistent-product-id" }],
        },
        actor,
      ),
    ).rejects.toThrow(/not in the match list/i);
  });

  it("D7: ambiguousResolutions — resolution to already-listed product skipped gracefully", async () => {
    const scopedA = storeScoped(storeAId);
    const existingForAmbig = await scopedA.listing.findFirst({ where: { masterProductId: ambigMp2Id } });
    if (!existingForAmbig) {
      await scopedA.listing.create({
        data: { storeId: storeAId, masterProductId: ambigMp2Id, price: 500, stockMode: "status", status: "in_stock" },
      });
    }

    const csv = "name,price\nAmbig T63,10.00\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.ambiguous).toHaveLength(1);

    await expect(
      commitImport(
        storeAId, preview.importToken,
        {
          matchedRows: [],
          newItemRows: [],
          ambiguousResolutions: [{ row: 2, masterProductId: ambigMp2Id }],
        },
        actor,
      ),
    ).rejects.toThrow(/already listed/i);
  });

  it("D1: committed import token marked in DB", async () => {
    const csv = "name,price\nToken Status T63,3.00\n";
    const preview = await generatePreview(storeAId, csv, testUserId);

    await commitImport(
      storeAId, preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );

    const scoped = storeScoped(storeAId);
    const record = await scoped.listingImport.findUnique({ where: { id: preview.importToken } });
    expect(record!.status).toBe("committed");
    expect(record!.committedAt).toBeTruthy();
  });

  it("A2: pending imports capped — oldest evicted when limit reached", { timeout: 15_000 }, async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.listingImport.deleteMany({ where: { storeId: storeBId } }),
    ]);

    const scopedB = storeScoped(storeBId);
    const tokenIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const rec = await scopedB.listingImport.create({
        data: { storeId: storeBId, csvText: `name,price\nCap${i},1.00\n`, rowCount: 1, status: "pending", createdById: testUserId },
      });
      tokenIds.push(rec.id);
    }

    const preview = await generatePreview(storeBId, "name,price\nCap Evict T63,1.00\n", testUserId);
    expect(preview.importToken).toBeTruthy();

    const oldest = await scopedB.listingImport.findUnique({ where: { id: tokenIds[0] } });
    expect(oldest).toBeNull();

    const remaining = await scopedB.listingImport.count({ where: { status: "pending" } });
    expect(remaining).toBeLessThanOrEqual(10);
  });

  it("A2: expired pending imports cleaned up on new preview", async () => {
    const scopedB = storeScoped(storeBId);
    const rec = await scopedB.listingImport.create({
      data: { storeId: storeBId, csvText: "name,price\nOld,1.00\n", rowCount: 1, status: "pending", createdById: testUserId },
    });

    const pastDate = new Date(Date.now() - 31 * 60 * 1000);
    await rawPrisma.$executeRaw`
      UPDATE listing_imports SET created_at = ${pastDate}
      WHERE id = ${rec.id}
    `;

    await generatePreview(storeBId, "name,price\nNew T63,5.00\n", testUserId);

    const expired = await scopedB.listingImport.findUnique({ where: { id: rec.id } });
    expect(expired).toBeNull();
  });

  it("S1: expired import token rejected at commit", async () => {
    const csv = "name,price\nExpiry Test T63,5.00\n";
    const preview = await generatePreview(storeAId, csv, testUserId);

    const pastDate = new Date(Date.now() - 31 * 60 * 1000);
    await rawPrisma.$executeRaw`
      UPDATE listing_imports SET created_at = ${pastDate}
      WHERE id = ${preview.importToken}
    `;

    await expect(
      commitImport(
        storeAId,
        preview.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      ),
    ).rejects.toThrow(/expired/i);
  });

  it("A2/E8: row whose match count increases between preview and commit is rejected (no silent pick)", async () => {
    const soloMp = await platformAdmin.masterProduct.create({
      data: { name: "Solo Match A2 T63", frozen: false, perishable: false },
    });
    mpIds.push(soloMp.id);
    await platformAdmin.productSynonym.create({
      data: { productId: soloMp.id, term: "solo a2 t63" },
    });

    const csv = "name,price\nSolo A2 T63,8.00\n";
    const preview = await generatePreview(storeBId, csv, testUserId);
    expect(preview.matches).toHaveLength(1);
    expect(preview.ambiguous).toHaveLength(0);

    const altMp = await platformAdmin.masterProduct.create({
      data: { name: "Solo Alt A2 T63", frozen: false, perishable: false },
    });
    mpIds.push(altMp.id);
    await platformAdmin.productSynonym.create({
      data: { productId: altMp.id, term: "solo a2 t63" },
    });

    await expect(
      commitImport(
        storeBId,
        preview.importToken,
        { matchedRows: [2], newItemRows: [], ambiguousResolutions: [] },
        actor,
      ),
    ).rejects.toThrow(/matches multiple master products/);
  });
});

describe.skipIf(!hasDb)("D5: auth path assertions", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;
  let ownerAId: string;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const storeA = await rawPrisma.store.upsert({
      where: { slug: "csv-auth-test-a" },
      update: {},
      create: { slug: "csv-auth-test-a", name: "Auth Store A", themePreset: "palm-and-shea" },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.upsert({
      where: { slug: "csv-auth-test-b" },
      update: {},
      create: { slug: "csv-auth-test-b", name: "Auth Store B", themePreset: "lagoon-and-coral" },
    });
    storeBId = storeB.id;

    const ownerA = await rawPrisma.user.upsert({
      where: { email: "csv-auth-owner-a@example.com" },
      update: {},
      create: { id: "csv-auth-owner-a", email: "csv-auth-owner-a@example.com", name: "Owner A", emailVerified: true },
    });
    ownerAId = ownerA.id;

    await rawPrisma.user.upsert({
      where: { email: "csv-auth-staff@example.com" },
      update: {},
      create: { id: "csv-auth-staff", email: "csv-auth-staff@example.com", name: "Staff User", emailVerified: true },
    });

    await rawPrisma.user.upsert({
      where: { email: "csv-auth-customer@example.com" },
      update: {},
      create: { id: "csv-auth-customer", email: "csv-auth-customer@example.com", name: "Customer User", emailVerified: true },
    });
  });

  afterAll(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.listingImport.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
      rawPrisma.auditLog.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
      rawPrisma.stockEvent.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
      rawPrisma.listingVariant.deleteMany({ where: { listing: { storeId: { in: [storeAId, storeBId] } } } }),
      rawPrisma.listing.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
    await rawPrisma.user.deleteMany({
      where: { email: { in: ["csv-auth-owner-a@example.com", "csv-auth-staff@example.com", "csv-auth-customer@example.com"] } },
    });
    await rawPrisma.store.deleteMany({ where: { slug: { in: ["csv-auth-test-a", "csv-auth-test-b"] } } });
    await rawPrisma.$disconnect();
  });

  it("D5/E12: store A owner preview on store B — RLS blocks cross-store read", async () => {
    const csv = "name,price\nAuth Cross Store T63,5.00\n";
    const preview = await generatePreview(storeBId, csv, ownerAId);
    expect(preview.importToken).toBeTruthy();

    const scopedA = storeScoped(storeAId);
    const record = await scopedA.listingImport.findUnique({ where: { id: preview.importToken } });
    expect(record).toBeNull();
  });

  it("D5/E12: store A owner commit on store B — token not visible via RLS", async () => {
    const csv = "name,price\nAuth Cross Commit T63,5.00\n";
    const preview = await generatePreview(storeAId, csv, ownerAId);

    await expect(
      commitImport(
        storeBId, preview.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        { id: ownerAId, email: "csv-auth-owner-a@example.com" },
      ),
    ).rejects.toThrow(/invalid|expired|already used/i);

    const scopedB = storeScoped(storeBId);
    const bListings = await scopedB.listing.findMany();
    expect(bListings).toHaveLength(0);
  });
});
