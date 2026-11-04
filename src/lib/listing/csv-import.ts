import { parse } from "csv-parse/sync";
import { platform, storeScoped, storeScopedTransaction, claimImportRow, lockStoreRow, IMPORT_TOKEN_TTL_MS } from "../db";
import { resolveStockMode, type Actor } from "./service";

const NON_CSV_REASON =
  "This does not look like a CSV file. Save it as CSV (UTF-8) and upload it again.";

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_ROWS = 5000;
const MAX_NAME_LENGTH = 200;

const DEFAULT_WEIGHT_G = 100;
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const PRICE_DOLLAR_RE = /^\$?\s*/;
const VALID_STATUSES = new Set(["in_stock", "low", "out_of_stock"]);
const VALID_STOCK_MODES = new Set(["counted", "status"]);

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
  /** Whole grams from a valid weight cell. Absent when the cell was empty. */
  weightG?: number;
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

const MAX_WEIGHT_G = 453592;
const MAX_WEIGHT_CELL_LENGTH = 32;
const WEIGHT_UNITS = new Set(["g", "kg", "lb", "lbs", "oz"]);
const UNIT_FACTOR: Record<string, { num: bigint; den: bigint }> = {
  g: { num: BigInt(1), den: BigInt(1) },
  kg: { num: BigInt(1000), den: BigInt(1) },
  lb: { num: BigInt(45359237), den: BigInt(100000) },
  lbs: { num: BigInt(45359237), den: BigInt(100000) },
  oz: { num: BigInt("28349523125"), den: BigInt("1000000000") },
};
const WEIGHT_CELL_RE = /^(-)?(\d+(?:\.\d+)?|\.\d+)\s*([A-Za-z]*)$/;
const WEIGHT_HEADER_RE = /^weight(?:_([a-z]+)|\(([a-z]+)\)|_\(([a-z]+)\))?$/;

const INVALID_WEIGHT = "Invalid weight";
const WEIGHT_NEEDS_UNIT = "Weight needs a unit: lb, oz, g or kg (for example 5 lb)";
const WEIGHT_TOO_SMALL = "Weight must be greater than 0";
const WEIGHT_TOO_LARGE = "Weight looks too large. Check the unit";

export type ParsedWeight =
  | { kind: "empty" }
  | { kind: "grams"; grams: number }
  | { kind: "error"; message: string };

/** `null` is a bare `weight` header. `undefined` means the header is not a weight column. */
function headerWeightUnit(normalized: string): string | null | undefined {
  const match = WEIGHT_HEADER_RE.exec(normalized);
  if (!match) return undefined;
  const unit = match[1] ?? match[2] ?? match[3];
  if (unit === undefined) return null;
  if (!WEIGHT_UNITS.has(unit)) return undefined;
  return unit;
}

function divHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * BigInt(2) >= denominator) return quotient + BigInt(1);
  return quotient;
}

function gramsFromDecimal(numeric: string, unit: string): bigint {
  const factor = UNIT_FACTOR[unit];
  const dot = numeric.indexOf(".");
  const whole = dot === -1 ? numeric : numeric.slice(0, dot);
  const frac = dot === -1 ? "" : numeric.slice(dot + 1);
  const scale = BigInt(10) ** BigInt(frac.length);
  const mantissa = BigInt((whole === "" ? "0" : whole) + frac);
  return divHalfUp(mantissa * factor.num, scale * factor.den);
}

export function parseWeightToGrams(cell: string, headerUnit: string | null): ParsedWeight {
  const trimmed = cell.trim();
  if (trimmed === "") return { kind: "empty" };
  if (trimmed.length > MAX_WEIGHT_CELL_LENGTH) {
    return { kind: "error", message: INVALID_WEIGHT };
  }
  const match = WEIGHT_CELL_RE.exec(trimmed);
  if (!match) return { kind: "error", message: INVALID_WEIGHT };

  const negative = match[1] === "-";
  const numeric = match[2];
  const letters = match[3].toLowerCase();
  let unit: string | null;
  if (letters === "") {
    unit = headerUnit;
    if (!unit) return { kind: "error", message: WEIGHT_NEEDS_UNIT };
  } else if (WEIGHT_UNITS.has(letters)) {
    unit = letters;
  } else {
    return { kind: "error", message: WEIGHT_NEEDS_UNIT };
  }

  if (negative) return { kind: "error", message: WEIGHT_TOO_SMALL };

  const grams = gramsFromDecimal(numeric, unit);
  if (grams <= BigInt(0)) return { kind: "error", message: WEIGHT_TOO_SMALL };
  if (grams > BigInt(MAX_WEIGHT_G)) return { kind: "error", message: WEIGHT_TOO_LARGE };
  return { kind: "grams", grams: Number(grams) };
}

function stripBom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1);
  return text;
}

function nonCsvParseResult(): {
  rows: ParsedRow[];
  errors: CsvPreviewError[];
  unknownColumns: string[];
  hasQtyColumn: boolean;
} {
  return {
    rows: [],
    errors: [{ row: 0, reason: NON_CSV_REASON }],
    unknownColumns: [],
    hasQtyColumn: false,
  };
}

/** Binary uploads and UTF-16 Excel exports are not CSV. U+FFFD alone is not enough. */
function isNonCsvText(text: string): boolean {
  if (text.includes("\u0000")) return true;
  if (text.startsWith("PK\u0003\u0004")) return true;
  if (text.startsWith("%PDF")) return true;
  if (text.startsWith("\uFFFD" + "PNG")) return true;
  return false;
}

export function parseCsvText(raw: string): {
  rows: ParsedRow[];
  errors: CsvPreviewError[];
  unknownColumns: string[];
  hasQtyColumn: boolean;
} {
  const cleaned = stripBom(raw);
  if (isNonCsvText(cleaned)) return nonCsvParseResult();

  const rows: ParsedRow[] = [];
  const errors: CsvPreviewError[] = [];

  let records: Record<string, string>[];
  let rawHeaders: string[] = [];
  try {
    records = parse(cleaned, {
      columns: (headers: string[]) => {
        rawHeaders = headers;
        return headers;
      },
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
      hasQtyColumn: false,
    };
  }

  if (records.length === 0) {
    return {
      rows: [],
      errors: [{ row: 0, reason: "File is empty or contains only headers." }],
      unknownColumns: [],
      hasQtyColumn: false,
    };
  }

  if (records.length > MAX_ROWS) {
    return {
      rows: [],
      errors: [{ row: 0, reason: `File exceeds the maximum of ${MAX_ROWS} rows.` }],
      unknownColumns: [],
      hasQtyColumn: false,
    };
  }

  const headers = Object.keys(records[0] ?? {});
  const normalizedMap = new Map<string, string>();
  const unknownColumns: string[] = [];
  for (const h of headers) {
    const norm = normalizeHeader(h);
    normalizedMap.set(h, norm);
    if (!KNOWN_HEADERS.has(norm) && headerWeightUnit(norm) === undefined) {
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
      hasQtyColumn: false,
    };
  }
  if (!priceCol) {
    return {
      rows: [],
      errors: [{ row: 0, reason: "Missing required column: price" }],
      unknownColumns,
      hasQtyColumn: false,
    };
  }

  const weightHeaderCount = rawHeaders.filter(
    (header) => headerWeightUnit(normalizeHeader(header)) !== undefined,
  ).length;
  if (weightHeaderCount > 1) {
    return {
      rows: [],
      errors: [{ row: 0, reason: "Use one weight column" }],
      unknownColumns,
      hasQtyColumn: false,
    };
  }

  const weightCol = headers.find(
    (header) => headerWeightUnit(normalizedMap.get(header) ?? "") !== undefined,
  );
  const headerUnit = weightCol
    ? headerWeightUnit(normalizedMap.get(weightCol) ?? "") ?? null
    : null;

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

    const stockModeRaw = stockModeCol ? record[stockModeCol]?.trim().toLowerCase().replace(/[\s-]/g, "_") || undefined : undefined;
    const qtyRaw = qtyCol ? record[qtyCol]?.trim() : undefined;
    const statusRaw = statusCol ? record[statusCol]?.trim().toLowerCase().replace(/[\s-]/g, "_") || undefined : undefined;

    if (stockModeRaw && !VALID_STOCK_MODES.has(stockModeRaw)) {
      errors.push({
        row: rowNum,
        csvName: rawName,
        reason: `Unrecognised stock_mode: "${record[stockModeCol!]?.trim()}". Use "counted" or "status".`,
      });
      continue;
    }

    if (statusRaw && !VALID_STATUSES.has(statusRaw)) {
      errors.push({
        row: rowNum,
        csvName: rawName,
        reason: `Unrecognised status: "${record[statusCol!]?.trim()}". Use "in_stock", "low", or "out_of_stock".`,
      });
      continue;
    }

    let weightG: number | undefined;
    if (weightCol) {
      const parsedWeight = parseWeightToGrams(record[weightCol] ?? "", headerUnit);
      if (parsedWeight.kind === "error") {
        errors.push({ row: rowNum, csvName: rawName, reason: parsedWeight.message });
        continue;
      }
      if (parsedWeight.kind === "grams") weightG = parsedWeight.grams;
    }

    let qty: number | undefined;
    if (qtyRaw !== undefined && qtyRaw !== "") {
      const parsed = parseInt(qtyRaw, 10);
      if (!isFinite(parsed) || parsed < 0 || parsed > 2_147_483_647) {
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
      stockMode: stockModeRaw as "counted" | "status" | undefined,
      qty,
      status: statusRaw as "in_stock" | "low" | "out_of_stock" | undefined,
      ...(weightG !== undefined ? { weightG } : {}),
    });
  }

  return { rows, errors, unknownColumns, hasQtyColumn: !!qtyCol };
}

const PRICE_THOUSANDS_RE = /^\d{1,3}(,\d{3})*(\.\d{1,2})?$/;
const PRICE_PLAIN_RE = /^\d+(\.\d{1,2})?$/;

export function parsePriceToCents(raw: string): number | null {
  let s = raw.replace(PRICE_DOLLAR_RE, "").trim();
  if (!s) return null;

  const negative = s.startsWith("-");
  if (negative) s = s.slice(1);

  if (!PRICE_THOUSANDS_RE.test(s) && !PRICE_PLAIN_RE.test(s)) return null;

  const clean = s.replace(/,/g, "");
  const parts = clean.split(".");
  const intPart = parts[0];
  const decPart = (parts[1] ?? "").padEnd(2, "0");

  const cents = parseInt(intPart, 10) * 100 + parseInt(decPart, 10);
  if (cents > 2_147_483_647) return null;
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
  weightG: number | null;
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


type ProductMatchList = Array<{ product: MasterProductRow; matchType: "exact" | "synonym" }>;

interface ExistingListingRow {
  id: string;
  masterProductId: string | null;
  customName: string | null;
}

function indexExistingListings(listings: ExistingListingRow[]) {
  const byMasterId = new Map<string, string>();
  const byCustomName = new Map<string, string>();
  for (const listing of listings) {
    if (listing.masterProductId) {
      byMasterId.set(listing.masterProductId, listing.id);
    } else if (listing.customName) {
      byCustomName.set(normalizeForMatch(listing.customName), listing.id);
    }
  }
  return { byMasterId, byCustomName };
}

function listingWeightG(weightG: number | null | undefined): number {
  return weightG && weightG > 0 ? weightG : DEFAULT_WEIGHT_G;
}

interface ListingToCreate {
  masterProductId: string | null;
  customName: string | null;
  price: number;
  stockMode: string;
  qty: number | null;
  status: string | null;
  frozen: boolean;
  perishable: boolean;
  weightG: number;
}

function buildListingData(
  row: ParsedRow,
  product: Pick<MasterProductRow, "id" | "frozen" | "perishable" | "weightG"> | null,
  hasQtyColumn: boolean,
): ListingToCreate {
  const stock = resolveStockMode({
    stockMode: row.stockMode,
    hasQtyColumn,
    qty: row.qty,
    status: row.status,
  });
  if (!product) {
    return {
      masterProductId: null,
      customName: row.name,
      price: row.price,
      ...stock,
      frozen: false,
      perishable: false,
      weightG: DEFAULT_WEIGHT_G,
    };
  }
  return {
    masterProductId: product.id,
    customName: null,
    price: row.price,
    ...stock,
    frozen: product.frozen,
    perishable: product.perishable,
    weightG: listingWeightG(product.weightG),
  };
}

async function matchParsedRows(rows: ParsedRow[]) {
  const uniqueNames = [...new Set(rows.map((r) => r.name))];
  return matchToMasterProducts(uniqueNames);
}

const EXISTING_LISTING_SELECT = {
  id: true,
  masterProductId: true,
  customName: true,
} as const;

type ExistingListingReader = {
  listing: {
    findMany: (args: {
      select: typeof EXISTING_LISTING_SELECT;
    }) => Promise<ExistingListingRow[]>;
  };
};

export async function buildMatchContext(csvText: string) {
  const parsed = parseCsvText(csvText);
  const matchMap =
    parsed.rows.length === 0
      ? new Map<string, ProductMatchList>()
      : await matchParsedRows(parsed.rows);

  return {
    rows: parsed.rows,
    errors: parsed.errors,
    unknownColumns: parsed.unknownColumns,
    hasQtyColumn: parsed.hasQtyColumn,
    matchMap,
    async bindExistingListings(reader: ExistingListingReader) {
      const listings =
        parsed.rows.length === 0
          ? []
          : await reader.listing.findMany({ select: EXISTING_LISTING_SELECT });
      return {
        rows: parsed.rows,
        errors: parsed.errors,
        unknownColumns: parsed.unknownColumns,
        hasQtyColumn: parsed.hasQtyColumn,
        matchMap,
        existing: indexExistingListings(listings),
      };
    },
  };
}

function classifyPreviewRows(
  rows: ParsedRow[],
  matchMap: Map<string, ProductMatchList>,
  existing: ReturnType<typeof indexExistingListings>,
) {
  const matches: CsvPreviewMatch[] = [];
  const ambiguous: CsvPreviewAmbiguous[] = [];
  const newItems: CsvPreviewNew[] = [];
  const alreadyListed: CsvPreviewAlreadyListed[] = [];
  const duplicates: CsvPreviewDuplicate[] = [];

  const seenNames = new Map<string, number>();
  const seenMasterProductIds = new Map<string, number>();

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
      const existingCustomId = existing.byCustomName.get(normName);
      if (existingCustomId) {
        alreadyListed.push({
          row: row.row,
          csvName: row.name,
          masterProductId: "",
          masterProductName: row.name,
          existingListingId: existingCustomId,
        });
      } else {
        newItems.push({ row: row.row, csvName: row.name, reason: "no master product match" });
      }
    } else if (productMatches.length === 1) {
      const m = productMatches[0];
      const mpDupRow = seenMasterProductIds.get(m.product.id);
      if (mpDupRow !== undefined) {
        duplicates.push({ row: row.row, csvName: row.name, firstRow: mpDupRow });
        continue;
      }
      seenMasterProductIds.set(m.product.id, row.row);
      const existingListingId = existing.byMasterId.get(m.product.id);
      if (existingListingId) {
        alreadyListed.push({
          row: row.row,
          csvName: row.name,
          masterProductId: m.product.id,
          masterProductName: m.product.name,
          existingListingId,
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

  return { matches, ambiguous, newItems, alreadyListed, duplicates };
}

function dropDuplicateBuiltItems(items: ListingToCreate[]): {
  kept: ListingToCreate[];
  duplicatesSkipped: number;
} {
  const seenMasterIds = new Set<string>();
  const seenCustomNames = new Set<string>();
  const kept: ListingToCreate[] = [];
  let duplicatesSkipped = 0;
  for (const item of items) {
    if (item.masterProductId) {
      if (seenMasterIds.has(item.masterProductId)) {
        duplicatesSkipped += 1;
        continue;
      }
      seenMasterIds.add(item.masterProductId);
      kept.push(item);
      continue;
    }
    if (item.customName) {
      const norm = normalizeForMatch(item.customName);
      if (seenCustomNames.has(norm)) {
        duplicatesSkipped += 1;
        continue;
      }
      seenCustomNames.add(norm);
      kept.push(item);
      continue;
    }
    kept.push(item);
  }
  return { kept, duplicatesSkipped };
}

export async function generatePreview(
  storeId: string,
  csvText: string,
  actorId: string,
): Promise<CsvPreviewResult> {
  const context = await buildMatchContext(csvText);

  if (context.rows.length === 0) {
    return {
      matches: [],
      ambiguous: [],
      newItems: [],
      alreadyListed: [],
      duplicates: [],
      errors: context.errors,
      unknownColumns: context.unknownColumns,
      importToken: "",
    };
  }

  const scoped = storeScoped(storeId);
  const ready = await context.bindExistingListings(scoped);
  const classified = classifyPreviewRows(ready.rows, ready.matchMap, ready.existing);

  const MAX_PENDING_IMPORTS = 10;
  const expiryCutoff = new Date(Date.now() - IMPORT_TOKEN_TTL_MS);
  await scoped.listingImport.deleteMany({
    where: { status: "pending", createdAt: { lt: expiryCutoff } },
  });

  const pendingCount = await scoped.listingImport.count({
    where: { status: "pending" },
  });
  if (pendingCount >= MAX_PENDING_IMPORTS) {
    const oldest = await scoped.listingImport.findFirst({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (oldest) {
      await scoped.listingImport.delete({ where: { id: oldest.id } });
    }
  }

  const importRecord = await scoped.listingImport.create({
    data: {
      storeId,
      csvText,
      rowCount: context.rows.length,
      status: "pending",
      createdById: actorId,
    },
  });

  return {
    ...classified,
    errors: context.errors,
    unknownColumns: context.unknownColumns,
    importToken: importRecord.id,
  };
}

export interface CommitSelection {
  matchedRows: number[];
  newItemRows: number[];
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
  const scoped = storeScoped(storeId);
  const importRecord = await scoped.listingImport.findUnique({
    where: { id: importToken },
  });

  if (!importRecord) {
    throw new Error("Import token is invalid, expired, or already used.");
  }
  if (importRecord.status === "committed") {
    throw new Error("This import has already been committed.");
  }

  const context = await buildMatchContext(importRecord.csvText);
  const rowMap = new Map(context.rows.map((r) => [r.row, r]));

  const selectedRows = new Set([
    ...selection.matchedRows,
    ...selection.newItemRows,
  ]);

  if (selectedRows.size === 0 && selection.ambiguousResolutions.length === 0) {
    throw new Error("No rows selected for import.");
  }

  const selectedNumbers = new Set<number>([
    ...selection.matchedRows,
    ...selection.newItemRows,
    ...selection.ambiguousResolutions.map((resolution) => resolution.row),
  ]);
  const notSelected = context.rows.filter((row) => !selectedNumbers.has(row.row)).length;

  const matchMap = context.matchMap;
  const toCreate: ListingToCreate[] = [];

  for (const rowNum of selectedRows) {
    const row = rowMap.get(rowNum);
    if (!row) continue;

    const productMatches = matchMap.get(row.name) ?? [];
    if (productMatches.length === 1) {
      toCreate.push(buildListingData(row, productMatches[0].product, context.hasQtyColumn));
    } else if (productMatches.length === 0) {
      toCreate.push(buildListingData(row, null, context.hasQtyColumn));
    } else {
      throw new Error(
        `Row ${rowNum} ("${row.name}") matches multiple master products. Use ambiguous resolutions to pick one.`,
      );
    }
  }

  for (const resolution of selection.ambiguousResolutions) {
    const row = rowMap.get(resolution.row);
    if (!row) continue;

    const allProducts = (matchMap.get(row.name) ?? []).map((m) => m.product);
    const selectedProduct = allProducts.find((p) => p.id === resolution.masterProductId);
    if (!selectedProduct) {
      throw new Error(
        `Resolution for row ${resolution.row} references product ${resolution.masterProductId} which is not in the match list.`,
      );
    }
    toCreate.push(buildListingData(row, selectedProduct, context.hasQtyColumn));
  }

  const { kept: dedupedToCreate, duplicatesSkipped } = dropDuplicateBuiltItems(toCreate);

  if (dedupedToCreate.length === 0) {
    throw new Error("No valid rows to import after re-validation.");
  }

  const listingIds = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    const didClaim = await claimImportRow(tx, importToken, IMPORT_TOKEN_TTL_MS);

    if (!didClaim) {
      const current = await tx.listingImport.findUnique({
        where: { id: importToken },
        select: { status: true },
      });
      if (current?.status === "committed") {
        throw new Error("This import has already been committed.");
      }
      throw new Error("Import token has expired. Please upload the file again.");
    }

    const ready = await context.bindExistingListings(tx);
    const existing = ready.existing;

    let alreadyListedSkipped = 0;
    const toInsert = dedupedToCreate.filter((item) => {
      const listedByMaster = item.masterProductId
        ? existing.byMasterId.has(item.masterProductId)
        : false;
      const listedByName = item.customName
        ? existing.byCustomName.has(normalizeForMatch(item.customName))
        : false;
      if (listedByMaster || listedByName) {
        alreadyListedSkipped += 1;
        return false;
      }
      return true;
    });

    if (toInsert.length === 0) {
      throw new Error("All selected listings are already listed in this store.");
    }

    const ids = toInsert.map(() => crypto.randomUUID());

    await tx.listing.createMany({
      data: toInsert.map((item, i) => ({
        id: ids[i],
        storeId,
        masterProductId: item.masterProductId,
        customName: item.customName,
        price: item.price,
        stockMode: item.stockMode,
        qty: item.qty,
        status: item.status,
        frozen: item.frozen,
        perishable: item.perishable,
      })),
    });

    await tx.listingVariant.createMany({
      data: toInsert.map((item, i) => ({
        listingId: ids[i],
        label: "Default",
        price: item.price,
        weightG: item.weightG,
      })),
    });

    const stockEvents = toInsert
      .map((item, i) => ({ item, listingId: ids[i] }))
      .filter(({ item }) => item.stockMode === "counted" && (item.qty ?? 0) > 0);

    if (stockEvents.length > 0) {
      await tx.stockEvent.createMany({
        data: stockEvents.map(({ item, listingId }) => ({
          storeId,
          listingId,
          type: "recount",
          delta: item.qty!,
          actorId: actor.id,
        })),
      });
    }

    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "catalog.csv_import",
        entityType: "listing",
        entityId: ids[0],
        after: {
          count: ids.length,
          listingIds: ids,
          importId: importToken,
          notSelected,
          duplicatesSkipped,
          alreadyListedSkipped,
        },
      },
    });

    return ids;
  }, { timeout: 60_000, maxWait: 15_000 });

  return { createdCount: listingIds.length, listingIds };
}

export function validateFileSize(bytes: number): string | null {
  if (bytes > MAX_FILE_BYTES) {
    return `File exceeds the maximum size of ${MAX_FILE_BYTES / (1024 * 1024)} MB.`;
  }
  return null;
}

export { MAX_FILE_BYTES, MAX_ROWS, MAX_NAME_LENGTH };
