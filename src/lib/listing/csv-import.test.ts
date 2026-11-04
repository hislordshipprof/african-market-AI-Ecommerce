import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  parseCsvText,
  parsePriceToCents,
  generatePreview,
  commitImport,
  buildMatchContext,
  validateFileSize,
  MAX_FILE_BYTES,
} from "./csv-import";
import { storeScoped, platformAdmin, claimImportRow, storeScopedTransaction, withSessionTimeZone, IMPORT_TOKEN_TTL_MS, healthQueryRaw } from "../db";
import { probeCrossStoreImportWrites } from "./cross-store-write";
import { commitPairBehindStoreLock } from "./import-lock-test-helpers";
import { createListing, resolveStockMode } from "./service";
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
  it("N4: rejects European comma decimal like '3,50'", () => {
    expect(parsePriceToCents("3,50")).toBeNull();
  });
  it("N4: rejects misplaced commas like '12,34,56'", () => {
    expect(parsePriceToCents("12,34,56")).toBeNull();
  });
  it("N4: accepts valid thousands separator '1,234'", () => {
    expect(parsePriceToCents("1,234")).toBe(123400);
  });
  it("N4: accepts multi-group thousands '1,234,567.89'", () => {
    expect(parsePriceToCents("1,234,567.89")).toBe(123456789);
  });
  it("A1: rejects price that overflows PostgreSQL int4 (>= $21,474,836.48)", () => {
    expect(parsePriceToCents("30000000.00")).toBeNull();
    expect(parsePriceToCents("21474836.48")).toBeNull();
  });
  it("A1: accepts largest valid price ($21,474,836.47)", () => {
    expect(parsePriceToCents("21474836.47")).toBe(2_147_483_647);
  });
});

describe("resolveStockMode (B3)", () => {
  it("explicit counted mode with qty", () => {
    const r = resolveStockMode({ stockMode: "counted", hasQtyColumn: true, qty: 25 });
    expect(r).toEqual({ stockMode: "counted", qty: 25, status: null });
  });

  it("explicit status mode with out_of_stock", () => {
    const r = resolveStockMode({ stockMode: "status", hasQtyColumn: false, status: "out_of_stock" });
    expect(r).toEqual({ stockMode: "status", qty: null, status: "out_of_stock" });
  });

  it("no stockMode but qty column present → counted", () => {
    const r = resolveStockMode({ hasQtyColumn: true, qty: 10 });
    expect(r).toEqual({ stockMode: "counted", qty: 10, status: null });
  });

  it("no stockMode, no qty column → status with default in_stock", () => {
    const r = resolveStockMode({ hasQtyColumn: false });
    expect(r).toEqual({ stockMode: "status", qty: null, status: "in_stock" });
  });

  it("no stockMode, no qty column, explicit status → preserves status", () => {
    const r = resolveStockMode({ hasQtyColumn: false, status: "out_of_stock" });
    expect(r).toEqual({ stockMode: "status", qty: null, status: "out_of_stock" });
  });

  it("no stockMode, qty column but no qty value → counted with 0", () => {
    const r = resolveStockMode({ hasQtyColumn: true });
    expect(r).toEqual({ stockMode: "counted", qty: 0, status: null });
  });

  it("invalid stockMode with qty column → counted", () => {
    const r = resolveStockMode({ stockMode: "invalid", hasQtyColumn: true, qty: 5 });
    expect(r).toEqual({ stockMode: "counted", qty: 5, status: null });
  });

  it("invalid stockMode without qty column → status", () => {
    const r = resolveStockMode({ stockMode: "invalid", hasQtyColumn: false });
    expect(r).toEqual({ stockMode: "status", qty: null, status: "in_stock" });
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

  const NON_CSV =
    "This does not look like a CSV file. Save it as CSV (UTF-8) and upload it again.";

  async function textFromBytes(bytes: Uint8Array): Promise<string> {
    return new Blob([Buffer.from(bytes)]).text();
  }

  function expectNonCsv(parsed: ReturnType<typeof parseCsvText>) {
    expect(parsed.rows).toEqual([]);
    expect(parsed.unknownColumns).toEqual([]);
    expect(parsed.hasQtyColumn).toBe(false);
    expect(parsed.errors).toEqual([{ row: 0, reason: NON_CSV }]);
  }

  it("N14: ZIP signature without a newline is rejected before parsing", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x01]);
    expectNonCsv(parseCsvText(await textFromBytes(bytes)));
  });

  it("N14: ZIP signature with a newline in the first record is rejected", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x14, 0x01]);
    expectNonCsv(parseCsvText(await textFromBytes(bytes)));
  });

  it("N14: PDF signature is rejected", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n");
    expectNonCsv(parseCsvText(await textFromBytes(bytes)));
  });

  it("N14: PNG signature is rejected", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expectNonCsv(parseCsvText(await textFromBytes(bytes)));
  });

  it("N14: UTF-16LE CSV with a BOM is rejected", async () => {
    const source = "name,price\nRice,5\n";
    const bytes = new Uint8Array(2 + source.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < source.length; i++) {
      bytes[2 + i * 2] = source.charCodeAt(i) & 0xff;
      bytes[3 + i * 2] = source.charCodeAt(i) >> 8;
    }
    expectNonCsv(parseCsvText(await textFromBytes(bytes)));
  });

  it("N14: UTF-16BE CSV with a BOM is rejected", async () => {
    const source = "name,price\nRice,5\n";
    const bytes = new Uint8Array(2 + source.length * 2);
    bytes[0] = 0xfe;
    bytes[1] = 0xff;
    for (let i = 0; i < source.length; i++) {
      bytes[2 + i * 2] = source.charCodeAt(i) >> 8;
      bytes[3 + i * 2] = source.charCodeAt(i) & 0xff;
    }
    expectNonCsv(parseCsvText(await textFromBytes(bytes)));
  });

  it("N14: NUL in an extra column is rejected and does not throw", async () => {
    const text = await textFromBytes(new TextEncoder().encode("name,price,notes\nRice,5,a\u0000b\n"));
    expectNonCsv(parseCsvText(text));
  });

  it("N14: NUL in a name cell is the non-CSV message", async () => {
    expectNonCsv(parseCsvText("name,price\nRice\u0000,5\n"));
  });

  it("N14: Windows-1252 Bîmba is not rejected", async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode("name,price\n"),
      0x42, 0xee, 0x6d, 0x62, 0x61,
      ...new TextEncoder().encode(",5.00\n"),
    ]);
    const parsed = parseCsvText(await textFromBytes(bytes));
    expect(parsed.errors.filter((e) => e.reason === NON_CSV)).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].name).toBe("B\uFFFDmba");
    expect(parsed.rows[0].price).toBe(500);
  });

  it("N14: a signature later in the file is a normal row", () => {
    const parsed = parseCsvText("name,price\n%PDF guide,5\n");
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].name).toBe("%PDF guide");
    expect(parsed.rows[0].price).toBe(500);
  });

  it("N14: UTF-8 BOM, CRLF and Café Noir still parse", async () => {
    const bytes = new TextEncoder().encode("\uFEFFname,price\r\nCafé Noir,4.50\r\n");
    const parsed = parseCsvText(await textFromBytes(bytes));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      expect.objectContaining({ name: "Café Noir", price: 450, row: 2 }),
    ]);
  });

  it("empty input: header-only file keeps the empty-file message", async () => {
    const parsed = parseCsvText(await textFromBytes(new TextEncoder().encode("name,price\n")));
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors).toEqual([
      { row: 0, reason: "File is empty or contains only headers." },
    ]);
  });

  it("empty input: a 0-byte file keeps the empty-file message", async () => {
    const parsed = parseCsvText(await textFromBytes(new Uint8Array()));
    expect(parsed.errors).toEqual([
      { row: 0, reason: "File is empty or contains only headers." },
    ]);
  });

  it("over the maximum: 5001 rows keeps the row-limit message", () => {
    const body = Array.from({ length: 5001 }, (_, i) => `Product${i},${i + 1}.00`).join("\n");
    const parsed = parseCsvText(`name,price\n${body}\n`);
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors).toEqual([
      { row: 0, reason: "File exceeds the maximum of 5000 rows." },
    ]);
  });

  it("money rounding: prices stay exact cents and no authorization cap applies", () => {
    expect(parsePriceToCents("12.50")).toBe(1250);
    expect(parsePriceToCents("0.01")).toBe(1);
    expect(parsePriceToCents("10.1")).toBe(1010);
    expect(parsePriceToCents("12.345")).toBeNull();
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

  it("B2: normalises status spaces/dashes to underscores", () => {
    const csv = "name,price,status\nA,1.00,Out of stock\nB,2.00,out-of-stock\nC,3.00,In Stock\nD,4.00,LOW\n";
    const { rows, errors } = parseCsvText(csv);
    expect(errors).toHaveLength(0);
    expect(rows.map((r) => r.status)).toEqual(["out_of_stock", "out_of_stock", "in_stock", "low"]);
  });

  it("B2: normalises stock_mode spaces/dashes to underscores", () => {
    const csv = "name,price,stock_mode,qty\nA,1.00,Counted,5\nB,2.00,STATUS,\n";
    const { rows, errors } = parseCsvText(csv);
    expect(errors).toHaveLength(0);
    expect(rows.map((r) => r.stockMode)).toEqual(["counted", "status"]);
  });

  it("B2: unrecognised status is a row error", () => {
    const csv = "name,price,status\nA,1.00,sold out\nB,2.00,in_stock\n";
    const { rows, errors } = parseCsvText(csv);
    expect(errors).toHaveLength(1);
    expect(errors[0].csvName).toBe("A");
    expect(errors[0].reason).toContain("status");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("in_stock");
  });

  it("B2: unrecognised stock_mode is a row error", () => {
    const csv = "name,price,stock_mode\nA,1.00,count\n";
    const { errors } = parseCsvText(csv);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("stock_mode");
  });

  it("B2: empty status/stock_mode cells are not errors", () => {
    const csv = "name,price,status,stock_mode\nA,1.00,,\n";
    const { rows, errors } = parseCsvText(csv);
    expect(errors).toHaveLength(0);
    expect(rows[0].status).toBeUndefined();
    expect(rows[0].stockMode).toBeUndefined();
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

  it("B3: hasQtyColumn true when qty column present", () => {
    const csv = "name,price,qty\nEgusi,12.50,10\n";
    const { hasQtyColumn } = parseCsvText(csv);
    expect(hasQtyColumn).toBe(true);
  });

  it("B3: hasQtyColumn true when quantity column present", () => {
    const csv = "name,price,quantity\nEgusi,12.50,10\n";
    const { hasQtyColumn } = parseCsvText(csv);
    expect(hasQtyColumn).toBe(true);
  });

  it("B3: hasQtyColumn false when no qty/quantity column", () => {
    const csv = "name,price\nEgusi,12.50\n";
    const { hasQtyColumn } = parseCsvText(csv);
    expect(hasQtyColumn).toBe(false);
  });

  it("B3: hasQtyColumn false when only status column present", () => {
    const csv = "name,price,status\nEgusi,12.50,in_stock\n";
    const { hasQtyColumn } = parseCsvText(csv);
    expect(hasQtyColumn).toBe(false);
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
const RUN = `t203-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function auditsForImport(storeId: string, importId: string) {
  const logs = await storeScoped(storeId).auditLog.findMany({
    where: { action: "catalog.csv_import" },
  });
  return logs.filter((entry) => {
    const after = entry.after as { importId?: string } | null;
    return after?.importId === importId;
  });
}

async function expectForeignKey(run: () => Promise<unknown>, constraint: string) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  const code = typeof caught === "object" && caught !== null && "code" in caught
    ? (caught as { code: unknown }).code
    : "";
  const message = caught instanceof Error ? caught.message : "";
  expect(code).toBe("P2003");
  expect(message).toContain(constraint);
}

async function expectRlsRejection(run: () => Promise<unknown>) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  const message = caught instanceof Error ? caught.message : "";
  expect(message).toMatch(/42501|row-level security/i);
}

async function expectPendingImport(storeId: string, importId: string) {
  const token = await storeScoped(storeId).listingImport.findUnique({ where: { id: importId } });
  expect(token?.status).toBe("pending");
  expect(token?.committedAt).toBeNull();
  expect(await auditsForImport(storeId, importId)).toEqual([]);
}

describe.skipIf(!hasDb)("generatePreview (DB integration)", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;
  let testUserId: string;
  let testUserEmail: string;
  const mpIds: string[] = [];

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const storeA = await rawPrisma.store.create({
      data: { slug: `csv-import-a-${RUN}`, name: `CSV Import Store A ${RUN}`, themePreset: "palm-and-shea" },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.create({
      data: { slug: `csv-import-b-${RUN}`, name: `CSV Import Store B ${RUN}`, themePreset: "lagoon-and-coral" },
    });
    storeBId = storeB.id;

    testUserEmail = `csv-import-${RUN}@example.com`;
    const user = await rawPrisma.user.create({
      data: { id: `csv-import-user-${RUN}`, email: testUserEmail, name: "CSV Test User", emailVerified: true },
    });
    testUserId = user.id;

    const mp1 = await platformAdmin.masterProduct.create({
      data: { name: `Zola Citrus Oil T63 ${RUN}`, frozen: false, perishable: false, status: "active" },
    });
    mpIds.push(mp1.id);

    const mp2 = await platformAdmin.masterProduct.create({
      data: { name: `Bimba Seed Flour T63 ${RUN}`, frozen: false, perishable: false, status: "active" },
    });
    mpIds.push(mp2.id);

    await platformAdmin.productSynonym.create({
      data: { productId: mp2.id, term: `Bimba Seeds T63 ${RUN}` },
    });
    await platformAdmin.productSynonym.create({
      data: { productId: mp2.id, term: `bimba ground t63 ${RUN}` },
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
      rawPrisma.productSynonym.deleteMany({ where: { productId: { in: mpIds } } }),
      rawPrisma.masterProduct.deleteMany({ where: { id: { in: mpIds } } }),
    ]);
    await rawPrisma.user.delete({ where: { id: testUserId } });
    await rawPrisma.store.delete({ where: { id: storeAId } });
    await rawPrisma.store.delete({ where: { id: storeBId } });
    await rawPrisma.$disconnect();
  });

  it("AC2: matches exact name (Zola Citrus Oil T63)", async () => {
    const csv = `name,price\nZola Citrus Oil T63 ${RUN},8.99\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.alreadyListed).toHaveLength(1);
    expect(preview.alreadyListed[0].masterProductName).toBe(`Zola Citrus Oil T63 ${RUN}`);
  });

  it("AC2: matches via synonym (Bimba Seeds T63)", async () => {
    const csv = `name,price\nBimba Seeds T63 ${RUN},12.50\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.matches).toHaveLength(1);
    expect(preview.matches[0].matchType).toBe("synonym");
    expect(preview.matches[0].masterProductName).toBe(`Bimba Seed Flour T63 ${RUN}`);
  });

  it("AC2: no match creates new item", async () => {
    const csv = "name,price\nMagic Spice Blend,5.99\n";
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.newItems).toHaveLength(1);
    expect(preview.newItems[0].csvName).toBe("Magic Spice Blend");
  });

  it("E7: already listed product shown as 'already listed'", async () => {
    const csv = `name,price\nZola Citrus Oil T63 ${RUN},10.99\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.alreadyListed).toHaveLength(1);
    expect(preview.alreadyListed[0].csvName).toBe(`Zola Citrus Oil T63 ${RUN}`);
  });

  it("E6: duplicate rows flagged", async () => {
    const csv = `name,price\nBimba Seeds T63 ${RUN},12.50\nBimba Seeds T63 ${RUN},15.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.duplicates).toHaveLength(1);
    expect(preview.duplicates[0].csvName).toBe(`Bimba Seeds T63 ${RUN}`);
    expect(preview.duplicates[0].firstRow).toBe(2);
  });

  it("N3: duplicate rows flagged by masterProductId, not only by name", async () => {
    const csv = `name,price\nBimba Seeds T63 ${RUN},12.50\nbimba ground t63 ${RUN},15.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.duplicates).toHaveLength(1);
    expect(preview.duplicates[0].csvName).toBe(`bimba ground t63 ${RUN}`);
    expect(preview.duplicates[0].firstRow).toBe(2);
    expect(preview.matches).toHaveLength(1);
    expect(preview.matches[0].csvName).toBe(`Bimba Seeds T63 ${RUN}`);
  });

  it("E9: unicode and accented names (Bimba vs Bîmba)", async () => {
    const csv = `name,price\nBîmba Seeds T63 ${RUN},12.50\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.matches).toHaveLength(1);
    expect(preview.matches[0].matchType).toBe("synonym");
  });

  it("E9: leading/trailing spaces trimmed for matching", async () => {
    const csv = `name,price\n  Bimba Seeds T63 ${RUN}  ,12.50\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.matches).toHaveLength(1);
  });

  it("D1: returns DB-backed import token", async () => {
    const csv = `name,price\nBimba Seeds T63 ${RUN},12.50\n`;
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
    const csv = `name,price\nZola Citrus Oil T63 ${RUN},10.99\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.alreadyListed.length).toBeGreaterThan(0);
    expect(preview.importToken).toBeTruthy();
  });

  it("E13: commit with zero selected rows", async () => {
    const csv = `name,price\nBimba Seeds T63 ${RUN},12.50\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    const actor: Actor = { id: testUserId, email: testUserEmail };
    await expect(
      commitImport(storeAId, preview.importToken, {
        matchedRows: [],
        newItemRows: [],
        ambiguousResolutions: [],
      }, actor),
    ).rejects.toThrow("No rows selected for import.");
  });

  it("N14: a non-CSV preview creates no import token", async () => {
    const scoped = storeScoped(storeAId);
    const before = await scoped.listingImport.count();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const text = await new Blob([Buffer.from(png)]).text();
    const preview = await generatePreview(storeAId, text, testUserId);
    expect(preview.importToken).toBe("");
    expect(preview.errors).toEqual([
      {
        row: 0,
        reason: "This does not look like a CSV file. Save it as CSV (UTF-8) and upload it again.",
      },
    ]);
    expect(await scoped.listingImport.count()).toBe(before);
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

    const storeA = await rawPrisma.store.create({
      data: { slug: `csv-commit-a-${RUN}`, name: `CSV Commit A ${RUN}`, themePreset: "palm-and-shea" },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.create({
      data: { slug: `csv-commit-b-${RUN}`, name: `CSV Commit B ${RUN}`, themePreset: "lagoon-and-coral" },
    });
    storeBId = storeB.id;

    const user = await rawPrisma.user.create({
      data: { id: `csv-commit-user-${RUN}`, email: `csv-commit-${RUN}@example.com`, name: "CSV Commit User", emailVerified: true },
    });
    testUserId = user.id;
    actor = { id: user.id, email: user.email };

    const mp = await platformAdmin.masterProduct.create({
      data: { name: `Kundi Flour T63 ${RUN}`, frozen: false, perishable: true, weightG: 11340, status: "active" },
    });
    mpIds.push(mp.id);

    await platformAdmin.productSynonym.create({
      data: { productId: mp.id, term: `kundi t63 ${RUN}` },
    });

    const ambig1 = await platformAdmin.masterProduct.create({
      data: { name: `Ambig Spice T63 ${RUN}`, frozen: false, perishable: false, status: "active" },
    });
    ambigMp1Id = ambig1.id;
    mpIds.push(ambig1.id);

    const ambig2 = await platformAdmin.masterProduct.create({
      data: { name: `Ambig Herb T63 ${RUN}`, frozen: false, perishable: false, status: "active" },
    });
    ambigMp2Id = ambig2.id;
    mpIds.push(ambig2.id);

    await platformAdmin.productSynonym.create({
      data: { productId: ambig1.id, term: `Ambig T63 ${RUN}` },
    });
    await platformAdmin.productSynonym.create({
      data: { productId: ambig2.id, term: `Ambig T63 ${RUN}` },
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
      rawPrisma.productSynonym.deleteMany({ where: { productId: { in: mpIds } } }),
      rawPrisma.masterProduct.deleteMany({ where: { id: { in: mpIds } } }),
    ]);
    await rawPrisma.user.delete({ where: { id: testUserId } });
    await rawPrisma.store.delete({ where: { id: storeAId } });
    await rawPrisma.store.delete({ where: { id: storeBId } });
    await rawPrisma.$disconnect();
  });

  it("AC3: creates matched listing in the correct store", async () => {
    const csv = `name,price\nKundi T63 ${RUN},6.99\n`;
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

  it("B3: name,price,qty CSV → counted mode with qty stored", async () => {
    const csv = `name,price,qty\nB3 Counted Item T63 ${RUN},5.00,42\n`;
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
    const listing = await scopedA.listing.findFirst({ where: { id: { in: result.listingIds } } });
    expect(listing!.stockMode).toBe("counted");
    expect(listing!.qty).toBe(42);
    expect(listing!.status).toBeNull();
  });

  it("B3: name,price,status CSV with out_of_stock → status mode preserving out_of_stock", async () => {
    const csv = `name,price,status\nB3 OOS Item T63 ${RUN},3.00,out_of_stock\n`;
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
    const listing = await scopedA.listing.findFirst({ where: { id: { in: result.listingIds } } });
    expect(listing!.stockMode).toBe("status");
    expect(listing!.status).toBe("out_of_stock");
    expect(listing!.qty).toBeNull();
  });

  it("B3: name,price only CSV → status mode with default in_stock", async () => {
    const csv = `name,price\nB3 Default Item T63 ${RUN},4.00\n`;
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
    const listing = await scopedA.listing.findFirst({ where: { id: { in: result.listingIds } } });
    expect(listing!.stockMode).toBe("status");
    expect(listing!.status).toBe("in_stock");
    expect(listing!.qty).toBeNull();
  });

  it("B3: explicit stock_mode=status overrides qty column presence", async () => {
    const csv = `name,price,stock_mode,qty,status\nB3 Explicit Status T63 ${RUN},6.00,status,,low\n`;
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
    const listing = await scopedA.listing.findFirst({ where: { id: { in: result.listingIds } } });
    expect(listing!.stockMode).toBe("status");
    expect(listing!.status).toBe("low");
    expect(listing!.qty).toBeNull();
  });

  it("B2: bulk commit of 1000 rows via createMany", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `B2 Bulk ${i} T63 ${RUN},${(i + 1)}.00`);
    const csv = "name,price\n" + rows.join("\n") + "\n";
    const preview = await generatePreview(storeBId, csv, testUserId);
    expect(preview.newItems.length).toBe(1000);

    const newItemRows = preview.newItems.map((n) => n.row);
    const result = await commitImport(
      storeBId,
      preview.importToken,
      { matchedRows: [], newItemRows, ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1000);
    expect(result.listingIds).toHaveLength(1000);

    const scopedB = storeScoped(storeBId);
    const bulkListings = await scopedB.listing.findMany({
      where: { id: { in: result.listingIds } },
      include: { variants: true },
    });
    expect(bulkListings).toHaveLength(1000);
    expect(bulkListings.every((l) => l.variants.length === 1)).toBe(true);
  }, 60_000);

  it("D6: store isolation — store B cannot see store A listings", async () => {
    const csv = `name,price\nStore A Only Item T63 ${RUN},7.50\n`;
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
    const csv = `name,price\nAudit Isolate ${RUN},3.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    const entries = await auditsForImport(storeAId, preview.importToken);
    expect(entries).toHaveLength(1);
    expect(entries[0].storeId).toBe(storeAId);
    expect(entries[0].action).toBe("catalog.csv_import");
    expect(await storeScoped(storeBId).auditLog.findUnique({ where: { id: entries[0].id } })).toBeNull();
  });

  it("audit entries are append-only for both stores", async () => {
    const csv = `name,price\nAudit Append ${RUN},3.50\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    const entries = await auditsForImport(storeAId, preview.importToken);
    expect(entries).toHaveLength(1);
    const before = entries[0];
    expect((await storeScoped(storeAId).auditLog.updateMany({
      where: { id: before.id },
      data: { actorEmail: `changed-${RUN}@example.com` },
    })).count).toBe(0);
    expect((await storeScoped(storeAId).auditLog.deleteMany({ where: { id: before.id } })).count).toBe(0);
    expect((await storeScoped(storeBId).auditLog.updateMany({
      where: { id: before.id },
      data: { actorEmail: `stolen-${RUN}@example.com` },
    })).count).toBe(0);
    expect((await storeScoped(storeBId).auditLog.deleteMany({ where: { id: before.id } })).count).toBe(0);
    const after = await storeScoped(storeAId).auditLog.findUnique({ where: { id: before.id } });
    expect(after).toEqual(before);
  });

  it("D6: store isolation — listing_variants isolated", async () => {
    const csv = `name,price\nVariant Isolation T63 ${RUN},4.00\n`;
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
    const csv = `name,price,stock_mode,qty\nStock Isolation T63 ${RUN},5.00,counted,10\n`;
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
    const csv = `name,price\nImport Isolation T63 ${RUN},3.00\n`;
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
    const csv = `name,price\nDouble Submit T63 ${RUN},5.00\n`;
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
    const csv = `name,price\nConcurrent Double T63 ${RUN},8.00\n`;
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

  it("E14: a failed last write rolls back the whole commit (status mode)", async () => {
    const name = `Rollback Status ${RUN}`;
    const csv = `name,price\n${name},9.99\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.newItems).toHaveLength(1);
    const selection = { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] };
    const missingActor: Actor = { id: `missing-actor-${RUN}`, email: `missing-${RUN}@example.com` };

    await expectForeignKey(
      () => commitImport(storeAId, preview.importToken, selection, missingActor),
      "audit_logs_actor_id_fkey",
    );

    const scoped = storeScoped(storeAId);
    expect(await scoped.listing.findMany({ where: { customName: name } })).toEqual([]);
    expect(await scoped.listingVariant.findMany({ where: { listing: { customName: name } } })).toEqual([]);
    expect(await scoped.stockEvent.findMany({ where: { listing: { customName: name } } })).toEqual([]);
    await expectPendingImport(storeAId, preview.importToken);

    const result = await commitImport(storeAId, preview.importToken, selection, actor);
    expect(result.createdCount).toBe(1);
    expect(await scoped.listing.findMany({ where: { customName: name } })).toHaveLength(1);
    expect(await scoped.stockEvent.findMany({ where: { listing: { customName: name } } })).toEqual([]);
    const after = await auditFor(storeAId, preview.importToken);
    expect(after.count).toBe(1);
    const token = await scoped.listingImport.findUnique({ where: { id: preview.importToken } });
    expect(token?.status).toBe("committed");
  });

  it("E14: a failed stock event write rolls back the whole commit (counted)", async () => {
    const name = `Rollback Counted ${RUN}`;
    const csv = `name,price,qty\n${name},3.00,3\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.newItems).toHaveLength(1);
    const selection = { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] };
    const missingActor: Actor = { id: `missing-actor-qty-${RUN}`, email: `missing-qty-${RUN}@example.com` };

    await expectForeignKey(
      () => commitImport(storeAId, preview.importToken, selection, missingActor),
      "stock_events_actor_id_fkey",
    );

    const scoped = storeScoped(storeAId);
    expect(await scoped.listing.findMany({ where: { customName: name } })).toEqual([]);
    expect(await scoped.listingVariant.findMany({ where: { listing: { customName: name } } })).toEqual([]);
    expect(await scoped.stockEvent.findMany({ where: { listing: { customName: name } } })).toEqual([]);
    await expectPendingImport(storeAId, preview.importToken);

    const result = await commitImport(storeAId, preview.importToken, selection, actor);
    expect(result.createdCount).toBe(1);
    const events = await scoped.stockEvent.findMany({ where: { listing: { customName: name } } });
    expect(events).toHaveLength(1);
    expect(events[0].delta).toBe(3);
    const after = await auditFor(storeAId, preview.importToken);
    expect(after.count).toBe(1);
    const token = await scoped.listingImport.findUnique({ where: { id: preview.importToken } });
    expect(token?.status).toBe("committed");
  });

  it("concurrent imports with separate tokens both succeed", async () => {
    const csvA = `name,price\nConcurrent Item A T63 ${RUN},3.00\n`;
    const csvB = `name,price\nConcurrent Item B T63 ${RUN},4.00\n`;

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

  it("E7/D2-reversed: concurrent commits of same new item — exactly one listing created", async () => {
    const csv = `name,price\nRace Item D2 T63 ${RUN},7.00\n`;

    const previewA = await generatePreview(storeAId, csv, testUserId);
    const previewB = await generatePreview(storeAId, csv, testUserId);

    const results = await Promise.allSettled([
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

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<{ createdCount: number }>).value.createdCount).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already listed/i);

    const scopedA = storeScoped(storeAId);
    const listings = await scopedA.listing.findMany({
      where: { customName: `Race Item D2 T63 ${RUN}` },
    });
    expect(listings).toHaveLength(1);
  }, 15_000);

  it("A3: crafted duplicateRows in selection are ignored (field removed)", async () => {
    const csv = `name,price\nDupe Bypass A T63 ${RUN},5.00\nDupe Bypass A T63 ${RUN},6.00\n`;
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
    const csv = `name,price\nKundi T63 ${RUN},6.99\nKundi T63 ${RUN},7.99\n`;
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
    const csv = `name,price\nUnique Custom F1 T63 ${RUN},6.99\nUnique Custom F1 T63 ${RUN},7.99\n`;
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
    expect(listing!.customName).toBe(`=HYPERLINK("http://evil.com")Attack`);
  });

  it("A1: formula-prefixed custom name detected as already-listed on re-import", async () => {
    const csv = `name,price\n=Special Sauce T63 ${RUN},7.00\n`;
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
    const csv = `name,price\nCross Store Token T63 ${RUN},5.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);

    await expect(
      commitImport(
        storeBId, preview.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      ),
    ).rejects.toThrow(/invalid|expired|already used/i);
  });

  it("D2-reversed: a store can have multiple listings for the same master product", async () => {
    const first = await createListing({
      storeId: storeAId,
      masterProductId: mpIds[0],
      price: 699,
      stockMode: "status",
      frozen: false,
      perishable: true,
      variants: [{ label: "Default", price: 699, weightG: 1 }],
      actor,
    });

    const second = await createListing({
      storeId: storeAId,
      masterProductId: mpIds[0],
      price: 799,
      stockMode: "status",
      frozen: false,
      perishable: true,
      variants: [{ label: "Default", price: 799, weightG: 1 }],
      actor,
    });

    expect(first.id).not.toBe(second.id);
    expect(second.masterProductId).toBe(mpIds[0]);
  });

  it("D3: custom-name already-listed blocked at commit", async () => {
    const name = `Unique Custom D3 T63 ${RUN}`;
    const scopedA = storeScoped(storeAId);
    const existing = await scopedA.listing.create({
      data: { storeId: storeAId, customName: name, price: 500, stockMode: "status", status: "in_stock" },
    });

    const csv = `name,price\n${name},6.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.alreadyListed).toHaveLength(1);
    expect(preview.newItems).toHaveLength(0);

    await expect(
      commitImport(
        storeAId,
        preview.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      ),
    ).rejects.toThrow("All selected listings are already listed in this store.");

    expect((await scopedA.listing.findMany({ where: { customName: name } })).map((row) => row.id)).toEqual([existing.id]);
    await expectPendingImport(storeAId, preview.importToken);
  });

  it("E8/D7: two master products sharing a synonym are ambiguous with 2 candidates, then a resolution creates the listing", async () => {
    const csv = `name,price\nAmbig T63 ${RUN},10.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.ambiguous).toHaveLength(1);
    expect(preview.ambiguous[0].candidates).toHaveLength(2);

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

  it("E8/D7: two master products sharing a synonym are ambiguous with 2 candidates, and a product outside the match list is rejected", async () => {
    const csv = `name,price\nAmbig T63 ${RUN},10.00\n`;
    const preview = await generatePreview(storeBId, csv, testUserId);
    expect(preview.ambiguous).toHaveLength(1);
    expect(preview.ambiguous[0].candidates).toHaveLength(2);

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

  it("E8/D7: two master products sharing a synonym are ambiguous with 2 candidates, and an already-listed resolution is skipped", async () => {
    const scopedA = storeScoped(storeAId);
    const existingForAmbig = await scopedA.listing.findFirst({ where: { masterProductId: ambigMp2Id } });
    if (!existingForAmbig) {
      await scopedA.listing.create({
        data: { storeId: storeAId, masterProductId: ambigMp2Id, price: 500, stockMode: "status", status: "in_stock" },
      });
    }

    const csv = `name,price\nAmbig T63 ${RUN},10.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.ambiguous).toHaveLength(1);
    expect(preview.ambiguous[0].candidates).toHaveLength(2);

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

  it("B1: matched import variant uses master product weightG", async () => {
    const weightMp = await platformAdmin.masterProduct.create({
      data: { name: `B1 Weight Rice T63 ${RUN}`, frozen: false, perishable: false, weightG: 11340, status: "active" },
    });
    mpIds.push(weightMp.id);
    await platformAdmin.productSynonym.create({
      data: { productId: weightMp.id, term: `b1 weight rice t63 ${RUN}` },
    });

    const csv = `name,price\nB1 Weight Rice T63 ${RUN},24.99\n`;
    const preview = await generatePreview(storeBId, csv, testUserId);
    expect(preview.matches).toHaveLength(1);

    const result = await commitImport(
      storeBId, preview.importToken,
      { matchedRows: [2], newItemRows: [], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1);

    const scopedB = storeScoped(storeBId);
    const listing = await scopedB.listing.findUnique({
      where: { id: result.listingIds[0] },
      include: { variants: true },
    });
    expect(listing!.variants).toHaveLength(1);
    expect(listing!.variants[0].weightG).toBe(11340);
  });

  it("B1: ambiguous-resolved import variant uses master product weightG", async () => {
    const csv = `name,price\nAmbig T63 ${RUN},10.00\n`;
    const preview = await generatePreview(storeBId, csv, testUserId);
    expect(preview.ambiguous).toHaveLength(1);

    const result = await commitImport(
      storeBId, preview.importToken,
      {
        matchedRows: [],
        newItemRows: [],
        ambiguousResolutions: [{ row: 2, masterProductId: ambigMp2Id }],
      },
      actor,
    );
    expect(result.createdCount).toBe(1);

    const scopedB = storeScoped(storeBId);
    const listing = await scopedB.listing.findUnique({
      where: { id: result.listingIds[0] },
      include: { variants: true },
    });
    expect(listing!.variants).toHaveLength(1);
    // ambig2 has no weightG set (null), so fallback to 100
    expect(listing!.variants[0].weightG).toBe(100);
  });

  it("B1: new custom item uses fallback weightG of 100", async () => {
    const csv = `name,price\nB1 Custom Widget T63 ${RUN},5.50\n`;
    const preview = await generatePreview(storeBId, csv, testUserId);
    expect(preview.newItems).toHaveLength(1);

    const result = await commitImport(
      storeBId, preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1);

    const scopedB = storeScoped(storeBId);
    const listing = await scopedB.listing.findUnique({
      where: { id: result.listingIds[0] },
      include: { variants: true },
    });
    expect(listing!.variants).toHaveLength(1);
    expect(listing!.variants[0].weightG).toBe(100);
  });

  it("D1: committed import token marked in DB", async () => {
    const csv = `name,price\nToken Status T63 ${RUN},3.00\n`;
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

    const preview = await generatePreview(storeBId, `name,price\nCap Evict T63 ${RUN},1.00\n`, testUserId);
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
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeBId}, true)`,
      rawPrisma.$executeRaw`UPDATE listing_imports SET created_at = ${pastDate} WHERE id = ${rec.id}`,
    ]);

    await generatePreview(storeBId, `name,price\nNew T63 ${RUN},5.00\n`, testUserId);

    const expired = await scopedB.listingImport.findUnique({ where: { id: rec.id } });
    expect(expired).toBeNull();
  });

  it("S1: expired import token rejected at commit", async () => {
    const csv = `name,price\nExpiry Test T63 ${RUN},5.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);

    const pastDate = new Date(Date.now() - 31 * 60 * 1000);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
      rawPrisma.$executeRaw`UPDATE listing_imports SET created_at = ${pastDate} WHERE id = ${preview.importToken}`,
    ]);

    await expect(
      commitImport(
        storeAId,
        preview.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      ),
    ).rejects.toThrow(/expired/i);
  });

  it("E8/B4: two master products sharing a synonym are ambiguous with 2 candidates, then the chosen candidate is created", async () => {
    const ambMp1 = await platformAdmin.masterProduct.create({
      data: { name: `Ambig Product Alpha T63 ${RUN}`, frozen: true, perishable: false, status: "active" },
    });
    mpIds.push(ambMp1.id);
    const ambMp2 = await platformAdmin.masterProduct.create({
      data: { name: `Ambig Product Beta T63 ${RUN}`, frozen: false, perishable: true, status: "active" },
    });
    mpIds.push(ambMp2.id);
    await platformAdmin.productSynonym.create({
      data: { productId: ambMp1.id, term: `ambig thing t63 ${RUN}` },
    });
    await platformAdmin.productSynonym.create({
      data: { productId: ambMp2.id, term: `ambig thing t63 ${RUN}` },
    });

    const csv = `name,price\nAmbig Thing T63 ${RUN},7.50\n`;
    const preview = await generatePreview(storeBId, csv, testUserId);
    expect(preview.ambiguous).toHaveLength(1);
    expect(preview.ambiguous[0].candidates).toHaveLength(2);

    const result = await commitImport(
      storeBId,
      preview.importToken,
      {
        matchedRows: [],
        newItemRows: [],
        ambiguousResolutions: [{ row: 2, masterProductId: ambMp2.id }],
      },
      actor,
    );

    expect(result.createdCount).toBe(1);
    const scopedB = storeScoped(storeBId);
    const listing = await scopedB.listing.findFirst({
      where: { masterProductId: ambMp2.id },
    });
    expect(listing).toBeTruthy();
    expect(listing!.price).toBe(750);
    expect(listing!.perishable).toBe(true);
  });

  it("A2: preview-to-commit match-count drift rejects the row (no silent pick)", async () => {
    const soloMp = await platformAdmin.masterProduct.create({
      data: { name: `Solo Match A2 T63 ${RUN}`, frozen: false, perishable: false, status: "active" },
    });
    mpIds.push(soloMp.id);
    await platformAdmin.productSynonym.create({
      data: { productId: soloMp.id, term: `solo a2 t63 ${RUN}` },
    });

    const csv = `name,price\nSolo A2 T63 ${RUN},8.00\n`;
    const preview = await generatePreview(storeBId, csv, testUserId);
    expect(preview.matches).toHaveLength(1);
    expect(preview.ambiguous).toHaveLength(0);

    const altMp = await platformAdmin.masterProduct.create({
      data: { name: `Solo Alt A2 T63 ${RUN}`, frozen: false, perishable: false, status: "active" },
    });
    mpIds.push(altMp.id);
    await platformAdmin.productSynonym.create({
      data: { productId: altMp.id, term: `solo a2 t63 ${RUN}` },
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

  async function auditFor(storeId: string, importId: string) {
    const matches = await auditsForImport(storeId, importId);
    expect(matches).toHaveLength(1);
    return matches[0].after as {
      count: number;
      listingIds: string[];
      importId: string;
      notSelected: number;
      duplicatesSkipped: number;
      alreadyListedSkipped: number;
    };
  }

  it("S1: one context carries parsed rows, master matches, and existing listings", async () => {
    const product = await platformAdmin.masterProduct.create({
      data: { name: `Context Yam T199 ${RUN}`, status: "active", frozen: false, perishable: false },
    });
    mpIds.push(product.id);
    const listing = await storeScoped(storeAId).listing.create({
      data: {
        storeId: storeAId,
        masterProductId: product.id,
        price: 200,
        stockMode: "status",
        status: "in_stock",
      },
    });

    const csv = `name,price\nContext Yam T199 ${RUN},2.00\nContext Loose T199 ${RUN},3.00\n`;
    const context = await buildMatchContext(csv);
    expect(context.rows.map((row) => row.name)).toEqual([
      `Context Yam T199 ${RUN}`,
      `Context Loose T199 ${RUN}`,
    ]);
    expect(context.matchMap.get(`Context Yam T199 ${RUN}`)?.[0]?.matchType).toBe("exact");
    expect(context.matchMap.get(`Context Loose T199 ${RUN}`)).toEqual([]);

    const ready = await context.bindExistingListings(storeScoped(storeAId));
    expect(ready.rows).toBe(context.rows);
    expect(ready.matchMap).toBe(context.matchMap);
    expect(ready.existing.byMasterId.get(product.id)).toBe(listing.id);
    const looseKey = `Context Loose T199 ${RUN}`.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
    expect(ready.existing.byCustomName.has(looseKey)).toBe(false);
  });

  it("N13: audit records duplicates, already listed, and the row left out", async () => {
    const beta = await platformAdmin.masterProduct.create({
      data: { name: `Audit Beta T199 ${RUN}`, status: "active", frozen: false, perishable: false },
    });
    const gamma = await platformAdmin.masterProduct.create({
      data: { name: `Audit Gamma T199 ${RUN}`, status: "active", frozen: false, perishable: false },
    });
    mpIds.push(beta.id, gamma.id);
    await platformAdmin.productSynonym.create({
      data: { productId: beta.id, term: `Audit Beta Syn T199 ${RUN}` },
    });

    const csv = [
      "name,price",
      `Audit Alpha T199 ${RUN},1.00`,
      `Audit Beta T199 ${RUN},2.00`,
      `Audit Beta Syn T199 ${RUN},2.50`,
      `Audit Gamma T199 ${RUN},3.00`,
      `Audit Delta T199 ${RUN},4.00`,
    ].join("\n");
    const preview = await generatePreview(storeBId, csv, testUserId);
    expect(preview.duplicates.map((row) => row.csvName)).toEqual([`Audit Beta Syn T199 ${RUN}`]);
    expect(preview.matches.map((row) => row.csvName)).toEqual([`Audit Beta T199 ${RUN}`, `Audit Gamma T199 ${RUN}`]);

    await storeScoped(storeBId).listing.create({
      data: {
        storeId: storeBId,
        masterProductId: gamma.id,
        price: 300,
        stockMode: "status",
        status: "in_stock",
      },
    });

    const result = await commitImport(
      storeBId,
      preview.importToken,
      { matchedRows: [3, 4, 5], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(2);

    const after = await auditFor(storeBId, preview.importToken);
    expect(after).toMatchObject({
      count: 2,
      duplicatesSkipped: 1,
      alreadyListedSkipped: 1,
      notSelected: 1,
      importId: preview.importToken,
    });
    expect(after.listingIds).toEqual(result.listingIds);
    expect(after.count + after.duplicatesSkipped + after.alreadyListedSkipped).toBe(4);

    const created = await storeScoped(storeBId).listing.findMany({
      where: { id: { in: result.listingIds } },
    });
    expect(created.filter((row) => row.customName === `Audit Alpha T199 ${RUN}`)).toHaveLength(1);
    expect(created.filter((row) => row.masterProductId === beta.id)).toHaveLength(1);
    expect(created.some((row) => row.masterProductId === gamma.id)).toBe(false);
  });

  it("duplicate through an ambiguous resolution skips the second master product", async () => {
    const exact = await platformAdmin.masterProduct.create({
      data: { name: `Palm Oil Exact T199 ${RUN}`, status: "active", frozen: false, perishable: false },
    });
    const other = await platformAdmin.masterProduct.create({
      data: { name: `Palm Oil Other T199 ${RUN}`, status: "active", frozen: false, perishable: false },
    });
    mpIds.push(exact.id, other.id);
    await platformAdmin.productSynonym.create({
      data: { productId: exact.id, term: `palm oil ambig t199 ${RUN}` },
    });
    await platformAdmin.productSynonym.create({
      data: { productId: other.id, term: `palm oil ambig t199 ${RUN}` },
    });

    const csv = `name,price\nPalm Oil Exact T199 ${RUN},5.00\npalm oil ambig t199 ${RUN},6.00\n`;
    const preview = await generatePreview(storeBId, csv, testUserId);
    expect(preview.matches).toHaveLength(1);
    expect(preview.ambiguous).toHaveLength(1);

    const result = await commitImport(
      storeBId,
      preview.importToken,
      {
        matchedRows: [2],
        newItemRows: [],
        ambiguousResolutions: [{ row: 3, masterProductId: exact.id }],
      },
      actor,
    );
    expect(result.createdCount).toBe(1);
    const after = await auditFor(storeBId, preview.importToken);
    expect(after.duplicatesSkipped).toBe(1);
    expect(after.alreadyListedSkipped).toBe(0);
    expect(after.count).toBe(1);
  });

  it("same custom name twice records duplicatesSkipped", async () => {
    const csv = `name,price\nSuya Mix T199 ${RUN},5.00\nsuya mix t199 ${RUN},6.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2, 3], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1);
    const after = await auditFor(storeAId, preview.importToken);
    expect(after.duplicatesSkipped).toBe(1);
    expect(after.notSelected).toBe(0);
  });

  it("unselected already-listed row counts as notSelected", async () => {
    await storeScoped(storeAId).listing.create({
      data: {
        storeId: storeAId,
        customName: `Already Sitting T199 ${RUN}`,
        price: 200,
        stockMode: "status",
        status: "in_stock",
      },
    });
    const csv = `name,price\nAlready Sitting T199 ${RUN},2.00\nFresh Pick T199 ${RUN},3.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.alreadyListed).toHaveLength(1);
    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [3], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1);
    const after = await auditFor(storeAId, preview.importToken);
    expect(after.notSelected).toBe(1);
    expect(after.alreadyListedSkipped).toBe(0);
  });

  it("listed between preview and commit sets alreadyListedSkipped", async () => {
    const csv = `name,price\nLate List T199 ${RUN},4.00\nKept List T199 ${RUN},5.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.newItems).toHaveLength(2);
    await storeScoped(storeAId).listing.create({
      data: {
        storeId: storeAId,
        customName: `Late List T199 ${RUN}`,
        price: 400,
        stockMode: "status",
        status: "in_stock",
      },
    });
    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2, 3], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1);
    const after = await auditFor(storeAId, preview.importToken);
    expect(after.alreadyListedSkipped).toBe(1);
    expect(after.count).toBe(1);
    const kept = await storeScoped(storeAId).listing.findFirst({
      where: { customName: `Kept List T199 ${RUN}` },
    });
    expect(kept?.customName).toBe(`Kept List T199 ${RUN}`);
  });

  it("D3: custom-name listed between preview and commit is skipped at commit (case, accents, spaces)", async () => {
    const pepper = `Pepper Soup Mix ${RUN}`;
    const suya = `Suya Spice ${RUN}`;
    const csv = `name,price\n${pepper},4.00\n${suya},5.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.newItems.map((row) => row.csvName)).toEqual([pepper, suya]);
    const manualName = `  PEPPER SOUP MÏX ${RUN}  `;
    const manual = await storeScoped(storeAId).listing.create({
      data: {
        storeId: storeAId,
        customName: manualName,
        price: 400,
        stockMode: "status",
        status: "in_stock",
      },
    });
    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2, 3], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1);
    const created = await storeScoped(storeAId).listing.findMany({ where: { id: { in: result.listingIds } } });
    expect(created.map((row) => row.customName)).toEqual([suya]);
    const soup = await storeScoped(storeAId).listing.findMany({
      where: { customName: { contains: "soup", mode: "insensitive" } },
    });
    expect(soup.map((row) => row.id)).toEqual([manual.id]);
    const after = await auditFor(storeAId, preview.importToken);
    expect(after.alreadyListedSkipped).toBe(1);
    expect(after.count).toBe(1);
  });

  it("master product listed between preview and commit is skipped at commit", async () => {
    const master = await platformAdmin.masterProduct.create({
      data: { name: `Listed Master ${RUN}`, status: "active", frozen: false, perishable: false },
    });
    mpIds.push(master.id);
    const kept = `Kept Beside Master ${RUN}`;
    const csv = `name,price\n${master.name},4.00\n${kept},5.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.matches).toHaveLength(1);
    expect(preview.matches[0].masterProductId).toBe(master.id);
    expect(preview.newItems.map((row) => row.csvName)).toEqual([kept]);
    const manual = await storeScoped(storeAId).listing.create({
      data: {
        storeId: storeAId,
        masterProductId: master.id,
        price: 400,
        stockMode: "status",
        status: "in_stock",
      },
    });
    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [2], newItemRows: [3], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1);
    const created = await storeScoped(storeAId).listing.findMany({ where: { id: { in: result.listingIds } } });
    expect(created).toHaveLength(1);
    expect(created[0].customName).toBe(kept);
    const masters = await storeScoped(storeAId).listing.findMany({ where: { masterProductId: master.id } });
    expect(masters.map((row) => row.id)).toEqual([manual.id]);
    const after = await auditFor(storeAId, preview.importToken);
    expect(after.alreadyListedSkipped).toBe(1);
    expect(after.count).toBe(1);
  });

  it("commit of only already-listed rows rejects and writes no audit", async () => {
    const name = `Only Listed ${RUN}`;
    const csv = `name,price\n${name},2.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.newItems).toHaveLength(1);
    const manual = await storeScoped(storeAId).listing.create({
      data: { storeId: storeAId, customName: name, price: 200, stockMode: "status", status: "in_stock" },
    });
    await expect(
      commitImport(
        storeAId,
        preview.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      ),
    ).rejects.toThrow("All selected listings are already listed in this store.");
    expect((await storeScoped(storeAId).listing.findMany({ where: { customName: name } })).map((row) => row.id)).toEqual([manual.id]);
    await expectPendingImport(storeAId, preview.importToken);
  });

  it("retry after a failed commit writes nothing, then one audit", async () => {
    const product = await platformAdmin.masterProduct.create({
      data: { name: `Retry After Fail T199 ${RUN}`, status: "active", frozen: false, perishable: false },
    });
    mpIds.push(product.id);
    const csv = `name,price\nRetry After Fail T199 ${RUN},7.77\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    expect(preview.matches).toHaveLength(1);
    const selection = { matchedRows: [2], newItemRows: [], ambiguousResolutions: [] };
    const missingActor: Actor = { id: `missing-actor-retry-${RUN}`, email: `missing-retry-${RUN}@example.com` };

    await expectForeignKey(
      () => commitImport(storeAId, preview.importToken, selection, missingActor),
      "audit_logs_actor_id_fkey",
    );

    const scoped = storeScoped(storeAId);
    expect(await scoped.listing.findMany({ where: { masterProductId: product.id } })).toEqual([]);
    expect(await scoped.listingVariant.findMany({ where: { listing: { masterProductId: product.id } } })).toEqual([]);
    expect(await scoped.stockEvent.findMany({ where: { listing: { masterProductId: product.id } } })).toEqual([]);
    await expectPendingImport(storeAId, preview.importToken);

    const result = await commitImport(storeAId, preview.importToken, selection, actor);
    expect(result.createdCount).toBe(1);
    expect(await scoped.listing.findMany({ where: { masterProductId: product.id } })).toHaveLength(1);
    const after = await auditFor(storeAId, preview.importToken);
    expect(after.count).toBe(1);
    expect(after.duplicatesSkipped).toBe(0);
    expect(after.alreadyListedSkipped).toBe(0);
    const token = await scoped.listingImport.findUnique({ where: { id: preview.importToken } });
    expect(token?.status).toBe("committed");
  });

  it("two commits of one token: one audit and the already-committed message", async () => {
    const csv = `name,price\nDouble Commit T199 ${RUN},8.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    const selection = { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] };
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
    const after = await auditFor(storeAId, preview.importToken);
    expect(after.count).toBe(1);
  });

  it("two tokens at once: the losing commit keeps its second item", async () => {
    const stamp = crypto.randomUUID();
    const shared = `Race Shared Lock ${stamp}`;
    const extra = `Race Extra Lock ${stamp}`;
    const previewA = await generatePreview(storeAId, `name,price\n${shared},7.00\n`, testUserId);
    const previewB = await generatePreview(
      storeAId,
      `name,price\n${shared},7.00\n${extra},8.00\n`,
      testUserId,
    );
    const { first, second } = await commitPairBehindStoreLock({
      storeId: storeAId,
      first: () => commitImport(
        storeAId,
        previewA.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      ),
      second: () => commitImport(
        storeAId,
        previewB.importToken,
        { matchedRows: [], newItemRows: [2, 3], ambiguousResolutions: [] },
        actor,
      ),
    });
    expect(first.createdCount).toBe(1);
    expect(second.createdCount).toBe(1);

    const sharedRows = await storeScoped(storeAId).listing.findMany({ where: { customName: shared } });
    expect(sharedRows).toHaveLength(1);
    const afterB = await auditFor(storeAId, previewB.importToken);
    expect(afterB.alreadyListedSkipped).toBe(1);
    expect(afterB.count).toBe(1);
  }, 30_000);

  it("the suite connects as app_runtime", async () => {
    const rows = (await healthQueryRaw`SELECT current_user`) as { current_user: string }[];
    expect(rows[0]?.current_user).toBe("app_runtime");
  });

  it("cross-store commit leaves the token pending and writes nothing", async () => {
    const csv = `name,price\nCross Store Commit T199 ${RUN},4.00\n`;
    const preview = await generatePreview(storeAId, csv, testUserId);
    const before = await storeScoped(storeBId).listing.count({ where: { customName: `Cross Store Commit T199 ${RUN}` } });
    await expect(
      commitImport(
        storeBId,
        preview.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      ),
    ).rejects.toThrow("Import token is invalid, expired, or already used.");
    expect(await storeScoped(storeBId).listing.count({ where: { customName: `Cross Store Commit T199 ${RUN}` } })).toBe(before);
    const token = await storeScoped(storeAId).listingImport.findUnique({ where: { id: preview.importToken } });
    expect(token?.status).toBe("pending");
  });

  it("cross-store write of audit_logs and listing_imports is rejected", async () => {
    const csvText = `name,price\nKeep Me T199 ${RUN},1.00\n`;
    const row = await storeScoped(storeAId).listingImport.create({
      data: {
        storeId: storeAId,
        csvText,
        rowCount: 1,
        status: "pending",
        createdById: testUserId,
      },
    });
    const probe = await probeCrossStoreImportWrites({
      storeAId,
      storeBId,
      actorId: testUserId,
      actorEmail: actor.email,
      listingImportId: row.id,
      expectedStatus: "pending",
      expectedCsvText: csvText,
    });
    expect(probe).toEqual({
      auditCreateRejected: true,
      importCreateRejected: true,
      updateCount: 0,
      deleteCount: 0,
      rowUnchanged: true,
    });
  });

  it("store B cannot change, delete or create store A's import-created listings, variants and stock events", async () => {
    const nameA = `Probe Listing A ${RUN}`;
    const nameB = `Probe Listing B ${RUN}`;
    const previewA = await generatePreview(storeAId, `name,price,qty\n${nameA},5.00,4\n`, testUserId);
    const previewB = await generatePreview(storeBId, `name,price,qty\n${nameB},6.00,2\n`, testUserId);
    const committedA = await commitImport(
      storeAId,
      previewA.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    const committedB = await commitImport(
      storeBId,
      previewB.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    expect(committedA.createdCount).toBe(1);
    expect(committedB.createdCount).toBe(1);

    const listingA = await storeScoped(storeAId).listing.findUnique({
      where: { id: committedA.listingIds[0] },
      include: { variants: true },
    });
    const listingB = await storeScoped(storeBId).listing.findUnique({
      where: { id: committedB.listingIds[0] },
      include: { variants: true },
    });
    expect(listingA?.storeId).toBe(storeAId);
    expect(listingA?.customName).toBe(nameA);
    expect(listingA?.variants).toHaveLength(1);
    expect(listingB?.storeId).toBe(storeBId);
    expect(listingB?.variants).toHaveLength(1);
    const variantA = listingA!.variants[0];
    const variantB = listingB!.variants[0];
    const eventsA = await storeScoped(storeAId).stockEvent.findMany({ where: { listingId: listingA!.id } });
    expect(eventsA).toHaveLength(1);
    expect(eventsA[0].delta).toBe(4);
    expect(eventsA[0].storeId).toBe(storeAId);

    expect(await storeScoped(storeBId).listing.findUnique({ where: { id: listingA!.id } })).toBeNull();
    expect(await storeScoped(storeBId).listingVariant.findUnique({ where: { id: variantA.id } })).toBeNull();
    expect(await storeScoped(storeBId).stockEvent.findUnique({ where: { id: eventsA[0].id } })).toBeNull();

    expect((await storeScoped(storeBId).listing.updateMany({ where: { id: listingA!.id }, data: { price: 1 } })).count).toBe(0);
    expect((await storeScoped(storeBId).listing.deleteMany({ where: { id: listingA!.id } })).count).toBe(0);
    expect((await storeScoped(storeBId).listingVariant.updateMany({ where: { id: variantA.id }, data: { price: 1 } })).count).toBe(0);
    expect((await storeScoped(storeBId).listingVariant.deleteMany({ where: { id: variantA.id } })).count).toBe(0);
    expect((await storeScoped(storeBId).stockEvent.updateMany({ where: { id: eventsA[0].id }, data: { delta: 99 } })).count).toBe(0);
    expect((await storeScoped(storeBId).stockEvent.deleteMany({ where: { id: eventsA[0].id } })).count).toBe(0);

    await expectRlsRejection(() => storeScoped(storeBId).listing.create({
      data: {
        storeId: storeAId,
        customName: `Stolen Listing ${RUN}`,
        price: 1,
        stockMode: "status",
        status: "in_stock",
      },
    }));
    await expectRlsRejection(() => storeScoped(storeBId).listing.update({
      where: { id: listingB!.id },
      data: { storeId: storeAId },
    }));
    await expectRlsRejection(() => storeScoped(storeBId).listingVariant.create({
      data: { listingId: listingA!.id, label: "Stolen", price: 1, weightG: 100 },
    }));
    await expectRlsRejection(() => storeScoped(storeBId).listingVariant.update({
      where: { id: variantB.id },
      data: { listingId: listingA!.id },
    }));
    await expectRlsRejection(() => storeScoped(storeBId).stockEvent.create({
      data: {
        storeId: storeAId,
        listingId: listingB!.id,
        type: "recount",
        delta: 1,
        actorId: testUserId,
      },
    }));

    const listingAAfter = await storeScoped(storeAId).listing.findUnique({
      where: { id: listingA!.id },
      include: { variants: true },
    });
    expect(listingAAfter).toEqual(listingA);
    expect(await storeScoped(storeAId).stockEvent.findMany({ where: { listingId: listingA!.id } })).toEqual(eventsA);
    const listingBAfter = await storeScoped(storeBId).listing.findUnique({
      where: { id: listingB!.id },
      include: { variants: true },
    });
    expect(listingBAfter).toEqual(listingB);
    expect(await storeScoped(storeBId).listing.findMany({ where: { customName: `Stolen Listing ${RUN}` } })).toEqual([]);
  });

  it("T1: a 29-minute token is claimed and a 31-minute token is not, in every zone", async () => {
    const zones = ["UTC", "America/Denver", "Europe/Berlin"] as const;
    for (const zone of zones) {
      const fresh = await storeScoped(storeAId).listingImport.create({
        data: {
          storeId: storeAId,
          csvText: `name,price\nFresh ${zone},1.00\n`,
          rowCount: 1,
          status: "pending",
          createdById: testUserId,
        },
      });
      const stale = await storeScoped(storeAId).listingImport.create({
        data: {
          storeId: storeAId,
          csvText: `name,price\nStale ${zone},1.00\n`,
          rowCount: 1,
          status: "pending",
          createdById: testUserId,
        },
      });
      const age29 = new Date(Date.now() - 29 * 60 * 1000);
      const age31 = new Date(Date.now() - 31 * 60 * 1000);
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
        rawPrisma.$executeRaw`UPDATE listing_imports SET created_at = ${age29} WHERE id = ${fresh.id}`,
        rawPrisma.$executeRaw`UPDATE listing_imports SET created_at = ${age31} WHERE id = ${stale.id}`,
      ]);

      const freshClaimed = await storeScopedTransaction(storeAId, async (tx) => {
        await tx.$executeRaw`SELECT set_config('TimeZone', ${zone}, true)`;
        return claimImportRow(tx, fresh.id, IMPORT_TOKEN_TTL_MS);
      });
      const staleClaimed = await storeScopedTransaction(storeAId, async (tx) => {
        await tx.$executeRaw`SELECT set_config('TimeZone', ${zone}, true)`;
        return claimImportRow(tx, stale.id, IMPORT_TOKEN_TTL_MS);
      });
      expect(freshClaimed).toBe(true);
      expect(staleClaimed).toBe(false);
      const staleRow = await storeScoped(storeAId).listingImport.findUnique({ where: { id: stale.id } });
      expect(staleRow?.status).toBe("pending");
    }
  });

  it("T1: commitImport expires a 31-minute token in every zone and keeps it pending", async () => {
    for (const zone of ["UTC", "America/Denver", "Europe/Berlin"]) {
      const preview = await generatePreview(
        storeAId,
        `name,price\nExpired ${zone} T199 ${RUN},5.00\n`,
        testUserId,
      );
      const past = new Date(Date.now() - 31 * 60 * 1000);
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
        rawPrisma.$executeRaw`UPDATE listing_imports SET created_at = ${past} WHERE id = ${preview.importToken}`,
      ]);
      await expect(
        withSessionTimeZone(zone, () =>
          commitImport(
            storeAId,
            preview.importToken,
            { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
            actor,
          ),
        ),
      ).rejects.toThrow("Import token has expired. Please upload the file again.");
      const token = await storeScoped(storeAId).listingImport.findUnique({
        where: { id: preview.importToken },
      });
      expect(token?.status).toBe("pending");
    }
  });

  it("T1: committedAt stays within 5 seconds of now in every zone", async () => {
    for (const zone of ["UTC", "America/Denver", "Europe/Berlin"]) {
      const preview = await generatePreview(
        storeAId,
        `name,price\nStamp ${zone} T199 ${RUN},3.00\n`,
        testUserId,
      );
      await withSessionTimeZone(zone, () =>
        commitImport(
          storeAId,
          preview.importToken,
          { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
          actor,
        ),
      );
      const token = await storeScoped(storeAId).listingImport.findUnique({
        where: { id: preview.importToken },
      });
      expect(token?.status).toBe("committed");
      expect(Math.abs(token!.committedAt!.getTime() - Date.now())).toBeLessThan(5000);
    }
  });

  it("expired versus committed: pending claim failure and committed token use different messages", async () => {
    const preview = await generatePreview(storeAId, `name,price\nMessage Split T199 ${RUN},5.00\n`, testUserId);
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
    ).rejects.toThrow("This import has already been committed.");
    const claimedAgain = await storeScopedTransaction(storeAId, (tx) =>
      claimImportRow(tx, preview.importToken, IMPORT_TOKEN_TTL_MS),
    );
    expect(claimedAgain).toBe(false);

    const expired = await generatePreview(storeAId, `name,price\nMessage Expired T199 ${RUN},5.00\n`, testUserId);
    const past = new Date(Date.now() - 31 * 60 * 1000);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
      rawPrisma.$executeRaw`UPDATE listing_imports SET created_at = ${past} WHERE id = ${expired.importToken}`,
    ]);
    const expiredClaim = await storeScopedTransaction(storeAId, (tx) =>
      claimImportRow(tx, expired.importToken, IMPORT_TOKEN_TTL_MS),
    );
    expect(expiredClaim).toBe(false);
    await expect(
      commitImport(
        storeAId,
        expired.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        actor,
      ),
    ).rejects.toThrow("Import token has expired. Please upload the file again.");
  });

  it("overnight hours: a commit does not consult store opening hours", async () => {
    const preview = await generatePreview(storeAId, `name,price\nNight Owl T199 ${RUN},2.50\n`, testUserId);
    const result = await commitImport(
      storeAId,
      preview.importToken,
      { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(1);
    const listing = await storeScoped(storeAId).listing.findUnique({ where: { id: result.listingIds[0] } });
    expect(listing?.price).toBe(250);
  });

  it("maximum input: 5000 selected rows record one audit", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `Max5000 T199 ${RUN} ${i},1.00`);
    const csv = `name,price\n${lines.join("\n")}\n`;
    const preview = await generatePreview(storeBId, csv, testUserId);
    expect(preview.newItems).toHaveLength(5000);
    const result = await commitImport(
      storeBId,
      preview.importToken,
      { matchedRows: [], newItemRows: preview.newItems.map((row) => row.row), ambiguousResolutions: [] },
      actor,
    );
    expect(result.createdCount).toBe(5000);
    const after = await auditFor(storeBId, preview.importToken);
    expect(after.count).toBe(5000);
    expect(after.duplicatesSkipped).toBe(0);
    expect(after.alreadyListedSkipped).toBe(0);
    expect(after.notSelected).toBe(0);
  }, 120_000);

});

describe("csv import database gate", () => {
  it("DB suites run in CI", () => {
    const ciSet = typeof process.env.CI === "string" && process.env.CI.length > 0;
    const hasDatabaseUrl = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;
    expect(ciSet && !hasDatabaseUrl).toBe(false);
  });
});

describe.skipIf(!hasDb)("D5: service-level cross-store actor check", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;
  let ownerAId: string;
  let ownerEmail: string;
  let staffId: string;
  let customerId: string;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const storeA = await rawPrisma.store.create({
      data: { slug: `csv-auth-a-${RUN}`, name: `Auth Store A ${RUN}`, themePreset: "palm-and-shea" },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.create({
      data: { slug: `csv-auth-b-${RUN}`, name: `Auth Store B ${RUN}`, themePreset: "lagoon-and-coral" },
    });
    storeBId = storeB.id;

    ownerEmail = `csv-auth-owner-${RUN}@example.com`;
    const ownerA = await rawPrisma.user.create({
      data: { id: `csv-auth-owner-${RUN}`, email: ownerEmail, name: "Owner A", emailVerified: true },
    });
    ownerAId = ownerA.id;

    const staff = await rawPrisma.user.create({
      data: { id: `csv-auth-staff-${RUN}`, email: `csv-auth-staff-${RUN}@example.com`, name: "Staff User", emailVerified: true },
    });
    staffId = staff.id;

    const customer = await rawPrisma.user.create({
      data: { id: `csv-auth-customer-${RUN}`, email: `csv-auth-customer-${RUN}@example.com`, name: "Customer User", emailVerified: true },
    });
    customerId = customer.id;
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
    await rawPrisma.user.delete({ where: { id: ownerAId } });
    await rawPrisma.user.delete({ where: { id: staffId } });
    await rawPrisma.user.delete({ where: { id: customerId } });
    await rawPrisma.store.delete({ where: { id: storeAId } });
    await rawPrisma.store.delete({ where: { id: storeBId } });
    await rawPrisma.$disconnect();
  });

  it("D5/E12: store A owner preview on store B — RLS blocks cross-store read", async () => {
    const csv = `name,price\nAuth Cross Store T63 ${RUN},5.00\n`;
    const preview = await generatePreview(storeBId, csv, ownerAId);
    const recordB = await storeScoped(storeBId).listingImport.findUnique({ where: { id: preview.importToken } });
    expect(recordB?.status).toBe("pending");
    expect(recordB?.storeId).toBe(storeBId);

    const record = await storeScoped(storeAId).listingImport.findUnique({ where: { id: preview.importToken } });
    expect(record).toBeNull();
  });

  it("D5/E12: store A owner commit on store B writes nothing under this test's names", async () => {
    const name = `Auth Cross Commit T63 ${RUN}`;
    const csv = `name,price\n${name},5.00\n`;
    const preview = await generatePreview(storeAId, csv, ownerAId);
    const tokenBefore = await storeScoped(storeAId).listingImport.findUnique({ where: { id: preview.importToken } });
    expect(tokenBefore?.status).toBe("pending");

    await expect(
      commitImport(
        storeBId, preview.importToken,
        { matchedRows: [], newItemRows: [2], ambiguousResolutions: [] },
        { id: ownerAId, email: ownerEmail },
      ),
    ).rejects.toThrow("Import token is invalid, expired, or already used.");

    const tokenAfter = await storeScoped(storeAId).listingImport.findUnique({ where: { id: preview.importToken } });
    expect(tokenAfter?.status).toBe("pending");
    expect(tokenAfter?.committedAt).toBeNull();
    expect(await storeScoped(storeBId).listing.findMany({ where: { customName: name } })).toEqual([]);
    expect(await storeScoped(storeBId).listingImport.findUnique({ where: { id: preview.importToken } })).toBeNull();
  });
});
