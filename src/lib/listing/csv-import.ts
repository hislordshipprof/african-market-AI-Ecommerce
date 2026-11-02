import { parse } from "csv-parse/sync";
import { platform, storeScoped, storeScopedTransaction } from "../db";
import type { Actor } from "./service";

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_ROWS = 5000;
const MAX_NAME_LENGTH = 200;

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const FORMULA_RE = /^[=+\-@]/;
const PRICE_DOLLAR_RE = /^\$?\s*/;
const PRICE_COMMAS_RE = /,/g;

export interface CsvPreviewMatch {
  row: number;
  csvName: string;
  masterProductId: string;
  masterProductName: string;
  matchType: "exact" | "synonym";
  frozen: boolean;
  perishable: boolean;
}

export interface CsvPreviewAmbiguous {
  row: number;
  csvName: string;
  candidates: Array<{
    masterProductId: string;
    masterProductName: string;
    matchType: "exact" | "synonym";
  }>;
}

export interface CsvPreviewNew {
  row: number;
  csvName: string;
  reason: string;
}

export interface CsvPreviewAlreadyListed {
  row: number;
  csvName: string;
  masterProductId: string;
  masterProductName: string;
  existingListingId: string;
}

export interface CsvPreviewError {
  row: number;
  csvName?: string;
  reason: string;
}

export interface CsvPreviewDuplicate {
  row: number;
  csvName: string;
  firstRow: number;
}

export interface CsvPreviewResult {
  matches: CsvPreviewMatch[];
  ambiguous: CsvPreviewAmbiguous[];
  newItems: CsvPreviewNew[];
  alreadyListed: CsvPreviewAlreadyListed[];
  duplicates: CsvPreviewDuplicate[];
  errors: CsvPreviewError[];
  unknownColumns: string[];
  importToken: string;
}

interface ParsedRow {
  row: number;
  name: string;
  price: number;
  stockMode?: string;
  qty?: number;
  status?: string;
}

const KNOWN_HEADERS = new Set([
  "name",
  "price",
  "stock_mode",
  "stockmode",
  "qty",
  "quantity",
  "status",
]);

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_-]+/g, "_");
}

function stripBom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1);
  return text;
}

export function parseCsvText(raw: string): {
  rows: ParsedRow[];
  errors: CsvPreviewError[];
  unknownColumns: string[];
} {
  const cleaned = stripBom(raw);
  const rows: ParsedRow[] = [];
  const errors: CsvPreviewError[] = [];

  let records: Record<string, string>[];
  try {
    records = parse(cleaned, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
    });
  } catch {
    return {
      rows: [],
      errors: [{ row: 0, reason: "Could not parse file as CSV. Check the file format." }],
      unknownColumns: [],
    };
  }

  if (records.length === 0) {
    return {
      rows: [],
      errors: [{ row: 0, reason: "File is empty or contains only headers." }],
      unknownColumns: [],
    };
  }

  if (records.length > MAX_ROWS) {
    return {
      rows: [],
      errors: [{ row: 0, reason: `File exceeds the maximum of ${MAX_ROWS} rows.` }],
      unknownColumns: [],
    };
  }

  const headers = Object.keys(records[0] ?? {});
  const normalizedMap = new Map<string, string>();
  const unknownColumns: string[] = [];
  for (const h of headers) {
    const norm = normalizeHeader(h);
    normalizedMap.set(h, norm);
    if (!KNOWN_HEADERS.has(norm)) {
      unknownColumns.push(h);
    }
  }

  const nameCol = headers.find((h) => normalizedMap.get(h) === "name");
  const priceCol = headers.find((h) => normalizedMap.get(h) === "price");
  const stockModeCol = headers.find(
    (h) => normalizedMap.get(h) === "stock_mode" || normalizedMap.get(h) === "stockmode",
  );
  const qtyCol = headers.find(
    (h) => normalizedMap.get(h) === "qty" || normalizedMap.get(h) === "quantity",
  );
  const statusCol = headers.find((h) => normalizedMap.get(h) === "status");

  if (!nameCol) {
    return {
      rows: [],
      errors: [{ row: 0, reason: "Missing required column: name" }],
      unknownColumns,
    };
  }
  if (!priceCol) {
    return {
      rows: [],
      errors: [{ row: 0, reason: "Missing required column: price" }],
      unknownColumns,
    };
  }

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const rowNum = i + 2; // 1-indexed, row 1 is header

    const rawName = record[nameCol]?.trim() ?? "";
    if (!rawName) {
      errors.push({ row: rowNum, reason: "Missing required field: name" });
      continue;
    }

    if (rawName.length > MAX_NAME_LENGTH) {
      errors.push({
        row: rowNum,
        csvName: rawName.slice(0, 50) + "...",
        reason: `Name exceeds ${MAX_NAME_LENGTH} characters.`,
      });
      continue;
    }

    if (CONTROL_CHAR_RE.test(rawName)) {
      errors.push({
        row: rowNum,
        csvName: rawName.slice(0, 50),
        reason: "Name contains invalid control characters.",
      });
      continue;
    }

    const rawPrice = record[priceCol]?.trim() ?? "";
    if (!rawPrice) {
      errors.push({ row: rowNum, csvName: rawName, reason: "Missing required field: price" });
      continue;
    }

    const priceCents = parsePriceToCents(rawPrice);
    if (priceCents === null) {
      errors.push({
        row: rowNum,
        csvName: rawName,
        reason: `Invalid price: "${rawPrice}". Use a number like 12.50 or $12.50.`,
      });
      continue;
    }

    if (priceCents < 0) {
      errors.push({
        row: rowNum,
        csvName: rawName,
        reason: "Price cannot be negative.",
      });
      continue;
    }

    if (priceCents === 0) {
      errors.push({
        row: rowNum,
        csvName: rawName,
        reason: "Price cannot be zero.",
      });
      continue;
    }

    const stockMode = stockModeCol ? record[stockModeCol]?.trim().toLowerCase() : undefined;
    const qtyRaw = qtyCol ? record[qtyCol]?.trim() : undefined;
    const statusRaw = statusCol ? record[statusCol]?.trim().toLowerCase() : undefined;

    let qty: number | undefined;
    if (qtyRaw !== undefined && qtyRaw !== "") {
      const parsed = parseInt(qtyRaw, 10);
      if (!isFinite(parsed) || parsed < 0) {
        errors.push({
          row: rowNum,
          csvName: rawName,
          reason: `Invalid quantity: "${qtyRaw}".`,
        });
        continue;
      }
      qty = parsed;
    }

    rows.push({
      row: rowNum,
      name: rawName,
      price: priceCents,
      stockMode: stockMode === "counted" || stockMode === "status" ? stockMode : undefined,
      qty,
      status:
        statusRaw === "in_stock" || statusRaw === "low" || statusRaw === "out_of_stock"
          ? statusRaw
          : undefined,
    });
  }

  return { rows, errors, unknownColumns };
}

export function parsePriceToCents(raw: string): number | null {
  let s = raw.replace(PRICE_DOLLAR_RE, "").replace(PRICE_COMMAS_RE, "").trim();
  if (!s) return null;

  const negative = s.startsWith("-");
  if (negative) s = s.slice(1);

  const dotIndex = s.indexOf(".");
  if (dotIndex !== -1) {
    const decimals = s.length - dotIndex - 1;
    if (decimals > 2) return null;
  }

  const parts = s.split(".");
  if (parts.length > 2) return null;

  const intPart = parts[0];
  const decPart = (parts[1] ?? "").padEnd(2, "0");

  if (!/^\d+$/.test(intPart) || !/^\d{2}$/.test(decPart)) return null;

  const cents = parseInt(intPart, 10) * 100 + parseInt(decPart, 10);
  return negative ? -cents : cents;
}

function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

interface MasterProductRow {
  id: string;
  name: string;
  frozen: boolean;
  perishable: boolean;
  synonyms: Array<{ term: string }>;
}

export async function matchToMasterProducts(
  csvNames: string[],
): Promise<
  Map<string, Array<{ product: MasterProductRow; matchType: "exact" | "synonym" }>>
> {
  const products = await platform.masterProduct.findMany({
    where: { status: "active" },
    include: { synonyms: true },
  });

  const result = new Map<
    string,
    Array<{ product: MasterProductRow; matchType: "exact" | "synonym" }>
  >();

  for (const csvName of csvNames) {
    const norm = normalizeForMatch(csvName);
    const matches: Array<{ product: MasterProductRow; matchType: "exact" | "synonym" }> = [];

    for (const p of products) {
      if (normalizeForMatch(p.name) === norm) {
        matches.push({ product: p, matchType: "exact" });
        continue;
      }

      for (const syn of p.synonyms) {
        if (normalizeForMatch(syn.term) === norm) {
          matches.push({ product: p, matchType: "synonym" });
          break;
        }
      }
    }

    result.set(csvName, matches);
  }

  return result;
}

const importTokens = new Map<
  string,
  {
    storeId: string;
    csvText: string;
    createdAt: number;
    used: boolean;
  }
>();

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function cleanExpiredTokens() {
  const now = Date.now();
  for (const [key, val] of importTokens) {
    if (now - val.createdAt > TOKEN_TTL_MS) {
      importTokens.delete(key);
    }
  }
}

export function createImportToken(storeId: string, csvText: string): string {
  cleanExpiredTokens();
  const token = crypto.randomUUID();
  importTokens.set(token, { storeId, csvText, createdAt: Date.now(), used: false });
  return token;
}

export function getImportTokenData(
  token: string,
  storeId: string,
): { csvText: string } | null {
  const data = importTokens.get(token);
  if (!data) return null;
  if (data.storeId !== storeId) return null;
  if (Date.now() - data.createdAt > TOKEN_TTL_MS) {
    importTokens.delete(token);
    return null;
  }
  if (data.used) return null;
  return { csvText: data.csvText };
}

export function markImportTokenUsed(token: string): void {
  const data = importTokens.get(token);
  if (data) data.used = true;
}

export async function generatePreview(
  storeId: string,
  csvText: string,
): Promise<CsvPreviewResult> {
  const { rows, errors, unknownColumns } = parseCsvText(csvText);

  if (rows.length === 0) {
    return {
      matches: [],
      ambiguous: [],
      newItems: [],
      alreadyListed: [],
      duplicates: [],
      errors,
      unknownColumns,
      importToken: "",
    };
  }

  const uniqueNames = [...new Set(rows.map((r) => r.name))];
  const matchMap = await matchToMasterProducts(uniqueNames);

  const scoped = storeScoped(storeId);
  const existingListings = await scoped.listing.findMany({
    where: { masterProductId: { not: null } },
    select: { id: true, masterProductId: true },
  });
  const existingMasterIds = new Set(existingListings.map((l) => l.masterProductId!));
  const existingListingByMaster = new Map(
    existingListings.map((l) => [l.masterProductId!, l.id]),
  );

  const matches: CsvPreviewMatch[] = [];
  const ambiguous: CsvPreviewAmbiguous[] = [];
  const newItems: CsvPreviewNew[] = [];
  const alreadyListed: CsvPreviewAlreadyListed[] = [];
  const duplicates: CsvPreviewDuplicate[] = [];

  const seenNames = new Map<string, number>();

  for (const row of rows) {
    const normName = normalizeForMatch(row.name);
    const firstRow = seenNames.get(normName);
    if (firstRow !== undefined) {
      duplicates.push({ row: row.row, csvName: row.name, firstRow });
      continue;
    }
    seenNames.set(normName, row.row);

    const productMatches = matchMap.get(row.name) ?? [];

    if (productMatches.length === 0) {
      newItems.push({ row: row.row, csvName: row.name, reason: "no master product match" });
    } else if (productMatches.length === 1) {
      const m = productMatches[0];
      if (existingMasterIds.has(m.product.id)) {
        alreadyListed.push({
          row: row.row,
          csvName: row.name,
          masterProductId: m.product.id,
          masterProductName: m.product.name,
          existingListingId: existingListingByMaster.get(m.product.id)!,
        });
      } else {
        matches.push({
          row: row.row,
          csvName: row.name,
          masterProductId: m.product.id,
          masterProductName: m.product.name,
          matchType: m.matchType,
          frozen: m.product.frozen,
          perishable: m.product.perishable,
        });
      }
    } else {
      ambiguous.push({
        row: row.row,
        csvName: row.name,
        candidates: productMatches.map((m) => ({
          masterProductId: m.product.id,
          masterProductName: m.product.name,
          matchType: m.matchType,
        })),
      });
    }
  }

  const importToken = createImportToken(storeId, csvText);

  return {
    matches,
    ambiguous,
    newItems,
    alreadyListed,
    duplicates,
    errors,
    unknownColumns,
    importToken,
  };
}

export interface CommitSelection {
  matchedRows: number[];
  newItemRows: number[];
  duplicateRows: number[];
  ambiguousResolutions: Array<{
    row: number;
    masterProductId: string;
  }>;
}

export interface CommitResult {
  createdCount: number;
  listingIds: string[];
}

export async function commitImport(
  storeId: string,
  importToken: string,
  selection: CommitSelection,
  actor: Actor,
): Promise<CommitResult> {
  const tokenData = getImportTokenData(importToken, storeId);
  if (!tokenData) {
    throw new Error("Import token is invalid, expired, or already used.");
  }

  const { rows, errors } = parseCsvText(tokenData.csvText);
  const rowMap = new Map(rows.map((r) => [r.row, r]));

  const selectedRows = new Set([
    ...selection.matchedRows,
    ...selection.newItemRows,
    ...selection.duplicateRows,
  ]);

  if (selectedRows.size === 0 && selection.ambiguousResolutions.length === 0) {
    throw new Error("No rows selected for import.");
  }

  const uniqueNames = [...new Set(rows.map((r) => r.name))];
  const matchMap = await matchToMasterProducts(uniqueNames);

  const scoped = storeScoped(storeId);
  const existingListings = await scoped.listing.findMany({
    where: { masterProductId: { not: null } },
    select: { id: true, masterProductId: true },
  });
  const existingMasterIds = new Set(existingListings.map((l) => l.masterProductId!));

  const ambiguousMap = new Map(
    selection.ambiguousResolutions.map((a) => [a.row, a.masterProductId]),
  );

  interface ListingToCreate {
    masterProductId: string | null;
    customName: string | null;
    price: number;
    stockMode: string;
    qty: number | null;
    status: string | null;
    frozen: boolean;
    perishable: boolean;
  }

  const toCreate: ListingToCreate[] = [];

  for (const rowNum of selectedRows) {
    const row = rowMap.get(rowNum);
    if (!row) continue;

    const productMatches = matchMap.get(row.name) ?? [];

    if (productMatches.length === 1) {
      const m = productMatches[0];
      if (existingMasterIds.has(m.product.id)) continue;

      toCreate.push({
        masterProductId: m.product.id,
        customName: null,
        price: row.price,
        stockMode: row.stockMode ?? "status",
        qty: row.stockMode === "counted" ? (row.qty ?? 0) : null,
        status: row.stockMode === "status" ? (row.status ?? "in_stock") : null,
        frozen: m.product.frozen,
        perishable: m.product.perishable,
      });
    } else if (productMatches.length === 0) {
      toCreate.push({
        masterProductId: null,
        customName: sanitizeName(row.name),
        price: row.price,
        stockMode: row.stockMode ?? "status",
        qty: row.stockMode === "counted" ? (row.qty ?? 0) : null,
        status: row.stockMode === "status" ? (row.status ?? "in_stock") : null,
        frozen: false,
        perishable: false,
      });
    }
  }

  for (const resolution of selection.ambiguousResolutions) {
    const row = rowMap.get(resolution.row);
    if (!row) continue;

    if (existingMasterIds.has(resolution.masterProductId)) continue;

    const allProducts = (matchMap.get(row.name) ?? []).map((m) => m.product);
    const selectedProduct = allProducts.find((p) => p.id === resolution.masterProductId);
    if (!selectedProduct) continue;

    toCreate.push({
      masterProductId: selectedProduct.id,
      customName: null,
      price: row.price,
      stockMode: row.stockMode ?? "status",
      qty: row.stockMode === "counted" ? (row.qty ?? 0) : null,
      status: row.stockMode === "status" ? (row.status ?? "in_stock") : null,
      frozen: selectedProduct.frozen,
      perishable: selectedProduct.perishable,
    });
  }

  if (toCreate.length === 0) {
    throw new Error("No valid rows to import after re-validation.");
  }

  markImportTokenUsed(importToken);

  const listingIds = await storeScopedTransaction(storeId, async (tx) => {
    const ids: string[] = [];

    for (const item of toCreate) {
      const listing = await tx.listing.create({
        data: {
          storeId,
          masterProductId: item.masterProductId,
          customName: item.customName,
          price: item.price,
          stockMode: item.stockMode,
          qty: item.qty,
          status: item.status,
          frozen: item.frozen,
          perishable: item.perishable,
        },
      });
      ids.push(listing.id);

      await tx.listingVariant.create({
        data: {
          listingId: listing.id,
          label: "Default",
          price: item.price,
          weightG: 1,
        },
      });

      if (item.stockMode === "counted" && (item.qty ?? 0) > 0) {
        await tx.stockEvent.create({
          data: {
            storeId,
            listingId: listing.id,
            type: "recount",
            delta: item.qty!,
            actorId: actor.id,
          },
        });
      }
    }

    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "catalog.csv_import",
        entityType: "listing",
        entityId: ids[0],
        after: { count: ids.length, listingIds: ids },
      },
    });

    return ids;
  });

  return { createdCount: listingIds.length, listingIds };
}

function sanitizeName(name: string): string {
  if (FORMULA_RE.test(name)) {
    return "'" + name;
  }
  return name;
}

export function validateFileSize(bytes: number): string | null {
  if (bytes > MAX_FILE_BYTES) {
    return `File exceeds the maximum size of ${MAX_FILE_BYTES / (1024 * 1024)} MB.`;
  }
  return null;
}

export { MAX_FILE_BYTES, MAX_ROWS, MAX_NAME_LENGTH };
