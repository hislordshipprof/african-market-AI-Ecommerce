import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Synchronous revalidateStorefront throws are the only cache failures this
// suite treats as still a successful import. Next applies queued tags after
// the action returns; a rejection there is outside the action result and is
// not claimed as a successful HTTP or Flight response.

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const actualBox = vi.hoisted(() => ({
  commitImport: undefined as
    | ((
        storeId: string,
        importToken: string,
        selection: {
          matchedRows: number[];
          newItemRows: number[];
          ambiguousResolutions: Array<{ row: number; masterProductId: string }>;
        },
        actor: { id: string; email: string },
      ) => Promise<{ createdCount: number; listingIds: string[]; needsWeightCount: number }>)
    | undefined,
}));

const { headerState, headerAls } = vi.hoisted(() => {
  // vi.hoisted runs before ESM imports, so AsyncLocalStorage is loaded here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AsyncLocalStorage } = require("node:async_hooks") as {
    AsyncLocalStorage: typeof import("node:async_hooks").AsyncLocalStorage;
  };
  return {
    headerState: new Headers(),
    headerAls: new AsyncLocalStorage<Headers>(),
  };
});

vi.mock("next/headers", () => ({
  headers: async () => headerAls.getStore() ?? headerState,
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("./csv-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./csv-import")>();
  actualBox.commitImport = actual.commitImport;
  return {
    ...actual,
    commitImport: vi.fn(actual.commitImport),
  };
});

import { Prisma } from "@prisma/client";
import { revalidateTag } from "next/cache";
import { headers } from "next/headers";
import { generateTOTP } from "../../../e2e/totp";
import { auth } from "../auth";
import { authPrisma, healthQueryRaw, platformAdmin, storeScoped, withSessionTimeZone } from "../db";
import { csvCommitAction, csvPreviewAction, type CommitActionResult } from "./csv-import-actions";
import { commitImport, type CommitSelection, type CsvPreviewResult } from "./csv-import";

// DATABASE_URL absent: the suite skips. Lane and hosted CI set it, so a real run skips 0.
// APP_RUNTIME_PASSWORD absent is not a skip: under NODE_ENV=test the app falls back to the
// owner URL and the current_user assertion fails. A required invocation
// (REQUIRE_CSV_COMMIT_ERRORS=1) fails closed before skipIf, with dotenv refill
// blocked by an empty string already present in the environment.

const REQUIRED_KEYS = ["DATABASE_URL", "DIRECT_URL", "APP_RUNTIME_PASSWORD", "BETTER_AUTH_SECRET"] as const;

function missingRequiredKeys(): string[] {
  return REQUIRED_KEYS.filter((key) => {
    const value = process.env[key];
    return value === undefined || value.trim() === "";
  });
}

if (process.env.REQUIRE_CSV_COMMIT_ERRORS === "1") {
  const missing = missingRequiredKeys();
  if (missing.length > 0) {
    throw new Error(`csv commit error suite requires ${missing.join(", ")}`);
  }
}

const BASE = "http://localhost:3000/api/auth";
const RUN = `t223-${Date.now()}`;
const password = "ImportErr-223!";
const GENERIC = "Import failed. Please try again.";
const INVALID = "Import token is invalid, expired, or already used.";
const ALREADY_COMMITTED = "This import has already been committed.";
const NO_ROWS = "No rows selected for import.";
const NO_VALID = "No valid rows to import after re-validation.";
const EXPIRED = "Import token has expired. Please upload the file again.";
const ALREADY_LISTED = "All selected listings are already listed in this store.";
const MISSING = "Missing import token. Please upload the file again.";
const COMMIT_LOG = "[csv-import] commit error:";
const REVALIDATE_LOG = "[csv-import] storefront revalidation failed:";
const SYNONYM = `T223 Grain ${RUN}`;
const EMPTY: CommitSelection = { matchedRows: [], newItemRows: [], ambiguousResolutions: [] };
const hasDb = !missingRequiredKeys().includes("DATABASE_URL");
const commitImportMock = vi.mocked(commitImport);
const revalidateTagMock = vi.mocked(revalidateTag);

class CookieJar {
  private readonly jar = new Map<string, string>();

  apply(response: Response): void {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const semi = raw.indexOf(";");
      const pair = (semi === -1 ? raw : raw.slice(0, semi)).trim();
      const attrs = semi === -1 ? "" : raw.slice(semi + 1);
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const maxAge = attrs.match(/max-age=([^;]+)/i)?.[1]?.trim();
      const expires = attrs.match(/expires=([^;]+)/i)?.[1]?.trim();
      const expired =
        value.length === 0 ||
        maxAge === "0" ||
        (expires !== undefined && Number.isFinite(Date.parse(expires)) && Date.parse(expires) <= Date.now());
      if (expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function csvImportLogs(): unknown[][] {
  return vi.mocked(console.error).mock.calls.filter(
    (call) => typeof call[0] === "string" && call[0].startsWith("[csv-import]"),
  );
}

function restoreServiceAndCacheDoubles(): void {
  const real = actualBox.commitImport;
  if (!real) throw new Error("real commitImport was not captured");
  commitImportMock.mockReset();
  commitImportMock.mockImplementation(real);
  revalidateTagMock.mockReset();
}

function newItems(rows: number[]): CommitSelection {
  return { matchedRows: [], newItemRows: rows, ambiguousResolutions: [] };
}

function countedCsv(rows: Array<[string, string, number]>): string {
  return `name,price,qty\n${rows.map((row) => row.join(",")).join("\n")}\n`;
}

function priceCsv(name: string, price = "4.50"): string {
  return `name,price\n${name},${price}\n`;
}

function asStore(slug: string, cookies: string): void {
  headerState.set("cookie", cookies);
  headerState.set("x-store-slug", slug);
}

function headersFor(slug: string, cookies: string): Headers {
  const value = new Headers();
  value.set("cookie", cookies);
  value.set("x-store-slug", slug);
  return value;
}

function inStore<T>(requestHeaders: Headers, run: () => Promise<T>): Promise<T> {
  return headerAls.run(requestHeaders, run);
}

function importIdOf(after: unknown): string | undefined {
  if (!after || typeof after !== "object" || !("importId" in after)) return undefined;
  const value = (after as { importId?: unknown }).importId;
  return typeof value === "string" ? value : undefined;
}

interface FiveTables {
  imports: Array<{ id: string; status: string; committedAt: string | null }>;
  listings: Array<{ id: string; customName: string | null; price: number; qty: number | null }>;
  variants: Array<{ id: string; listingId: string; price: number; weightG: number }>;
  stock: Array<{ id: string; listingId: string; type: string; delta: number; actorId: string }>;
  audits: Array<{ id: string; action: string; actorId: string; entityId: string; after: unknown }>;
}

async function fiveTables(storeId: string): Promise<FiveTables> {
  const scoped = storeScoped(storeId);
  const [imports, listings, stock, audits] = await Promise.all([
    scoped.listingImport.findMany({ orderBy: { id: "asc" } }),
    scoped.listing.findMany({ orderBy: { id: "asc" }, include: { variants: { orderBy: { id: "asc" } } } }),
    scoped.stockEvent.findMany({ orderBy: { id: "asc" } }),
    scoped.auditLog.findMany({ orderBy: { id: "asc" } }),
  ]);
  return {
    imports: imports.map((row) => ({
      id: row.id,
      status: row.status,
      committedAt: row.committedAt?.toISOString() ?? null,
    })),
    listings: listings.map((row) => ({
      id: row.id,
      customName: row.customName,
      price: row.price,
      qty: row.qty,
    })),
    variants: listings.flatMap((row) =>
      row.variants.map((variant) => ({
        id: variant.id,
        listingId: variant.listingId,
        price: variant.price,
        weightG: variant.weightG,
      })),
    ),
    stock: stock.map((row) => ({
      id: row.id,
      listingId: row.listingId,
      type: row.type,
      delta: row.delta,
      actorId: row.actorId,
    })),
    audits: audits.map((row) => ({
      id: row.id,
      action: row.action,
      actorId: row.actorId,
      entityId: row.entityId,
      after: row.after,
    })),
  };
}

function expectVerbatim(res: CommitActionResult, message: string): void {
  expect(res.error).toBe(message);
  expect(res.result).toBeUndefined();
  expect(csvImportLogs()).toEqual([]);
  expect(revalidateTagMock).not.toHaveBeenCalled();
}

function expectGeneric(res: CommitActionResult, thrown: unknown, storeId: string): void {
  expect(res.error).toBe(GENERIC);
  expect(res.result).toBeUndefined();
  const logs = csvImportLogs();
  expect(logs).toHaveLength(1);
  expect(logs[0]?.[0]).toBe(COMMIT_LOG);
  expect(logs[0]?.[1]).toBe(thrown);
  expect(revalidateTagMock).not.toHaveBeenCalled();
  const text = res.error ?? "";
  expect(text).not.toContain("listing_imports");
  expect(text).not.toContain("row-level");
  expect(text).not.toContain("42501");
  expect(text).not.toContain(storeId);
}

function cacheInvariant(storeId: string): Error {
  return new Error(`Invariant: static generation store missing in revalidateTag("storefront:${storeId}")`);
}

function openWhenBothArrive() {
  let arrived = 0;
  let opened = false;
  let resolve = () => {};
  const gate = new Promise<void>((done) => {
    resolve = done;
  });
  const release = () => {
    if (opened) return;
    opened = true;
    resolve();
  };
  return {
    arrived: () => arrived,
    release,
    async enter() {
      arrived += 1;
      if (arrived >= 2) release();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("both commits did not reach commitImport")), 8_000);
      });
      try {
        await Promise.race([gate, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

async function authPost(path: string, body: unknown, cookies?: string): Promise<Response> {
  const requestHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies) requestHeaders.cookie = cookies;
  return auth.handler(
    new Request(`${BASE}${path}`, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) }),
  );
}

const usedTotp = new Map<string, string>();

function totp(secret: string): string {
  const code = generateTOTP(secret);
  usedTotp.set(secret, code);
  return code;
}

describe.skipIf(!hasDb)("csv commit action: errors and cache (real auth, app_runtime)", () => {
  const storeAId = crypto.randomUUID();
  const storeBId = crypto.randomUUID();
  const storeCId = crypto.randomUUID();
  const storeASlug = `a-${RUN}`;
  const storeBSlug = `b-${RUN}`;
  const storeCSlug = `c-${RUN}`;
  const emails = {
    ownerA: `ownera-${RUN}@example.com`,
    ownerB: `ownerb-${RUN}@example.com`,
  };
  const ids = { ownerA: "", ownerB: "" };
  const cookies = { ownerA: "", ownerB: "" };
  const masterIds: string[] = [];
  let consoleSpy: ReturnType<typeof vi.spyOn> | undefined;

  async function signUp(email: string, name: string): Promise<CookieJar> {
    const jar = new CookieJar();
    const res = await authPost("/sign-up/email", { email, password, name });
    expect(res.status, await res.clone().text()).toBe(200);
    jar.apply(res);
    return jar;
  }

  async function enableVerified(email: string): Promise<CookieJar> {
    const jar = new CookieJar();
    const signedIn = await authPost("/sign-in/email", { email, password });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    jar.apply(signedIn);
    const signedBody = (await signedIn.json()) as { twoFactorRedirect?: boolean };
    expect(signedBody.twoFactorRedirect).not.toBe(true);
    const enabled = await authPost("/two-factor/enable", { password }, jar.header());
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    jar.apply(enabled);
    const body = (await enabled.json()) as { totpURI?: string };
    const secret = new URL(body.totpURI ?? "http://localhost").searchParams.get("secret");
    expect(secret).toBeTruthy();
    const verified = await authPost("/two-factor/verify-totp", { code: totp(secret!) }, jar.header());
    expect(verified.status, await verified.clone().text()).toBe(200);
    jar.apply(verified);
    return jar;
  }

  async function previewCsv(slug: string, cookie: string, csv: string): Promise<CsvPreviewResult> {
    asStore(slug, cookie);
    const form = new FormData();
    form.set("file", new File([csv], "import.csv", { type: "text/csv" }));
    const preview = await csvPreviewActionSafe(form);
    expect(preview.importToken).toBeTruthy();
    return preview;
  }

  async function csvPreviewActionSafe(form: FormData): Promise<CsvPreviewResult> {
    const preview = await csvPreviewAction(form);
    expect(preview.error, preview.error).toBeUndefined();
    expect(preview.preview).toBeTruthy();
    return preview.preview!;
  }

  function commitAs(slug: string, cookie: string, token: string, selection: CommitSelection) {
    asStore(slug, cookie);
    return csvCommitAction(token, selection);
  }

  async function backdate(id: string, ageMs: number): Promise<void> {
    await platformAdmin.listingImport.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - ageMs) },
    });
  }

  async function tokenRow(storeId: string, id: string) {
    return storeScoped(storeId).listingImport.findUnique({ where: { id } });
  }

  beforeAll(async () => {
    await signUp(emails.ownerA, "Owner A");
    await signUp(emails.ownerB, "Owner B");
    ids.ownerA = (await authPrisma.user.findFirstOrThrow({ where: { email: emails.ownerA } })).id;
    ids.ownerB = (await authPrisma.user.findFirstOrThrow({ where: { email: emails.ownerB } })).id;
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      const stores: Array<[string, string, string]> = [
        [storeAId, `T223 A ${RUN}`, storeASlug],
        [storeBId, `T223 B ${RUN}`, storeBSlug],
        [storeCId, `T223 C ${RUN}`, storeCSlug],
      ];
      for (const [id, name, slug] of stores) {
        await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${id}, ${name}, ${slug}, 'active', now())`;
      }
      const memberships: Array<[string, string]> = [
        [storeAId, ids.ownerA],
        [storeCId, ids.ownerA],
        [storeBId, ids.ownerB],
      ];
      for (const [storeId, userId] of memberships) {
        await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${userId}, 'owner', now())`;
      }
    });
    cookies.ownerA = (await enableVerified(emails.ownerA)).header();
    cookies.ownerB = (await enableVerified(emails.ownerB)).header();
    const alpha = await platformAdmin.masterProduct.create({
      data: { name: `T223 Alpha ${RUN}`, status: "active" },
    });
    const beta = await platformAdmin.masterProduct.create({
      data: { name: `T223 Beta ${RUN}`, status: "active" },
    });
    masterIds.push(alpha.id, beta.id);
    await platformAdmin.productSynonym.create({ data: { productId: alpha.id, term: SYNONYM } });
    await platformAdmin.productSynonym.create({ data: { productId: beta.id, term: SYNONYM } });
  }, 120_000);

  afterAll(async () => {
    const storeIds = [storeAId, storeBId, storeCId];
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM listing_variants WHERE listing_id IN (SELECT id FROM listings WHERE store_id IN (${storeIds[0]}, ${storeIds[1]}, ${storeIds[2]}))`;
      await tx.$executeRaw`DELETE FROM stock_events WHERE store_id IN (${storeIds[0]}, ${storeIds[1]}, ${storeIds[2]})`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id IN (${storeIds[0]}, ${storeIds[1]}, ${storeIds[2]})`;
      await tx.$executeRaw`DELETE FROM listings WHERE store_id IN (${storeIds[0]}, ${storeIds[1]}, ${storeIds[2]})`;
      await tx.$executeRaw`DELETE FROM listing_imports WHERE store_id IN (${storeIds[0]}, ${storeIds[1]}, ${storeIds[2]})`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE store_id IN (${storeIds[0]}, ${storeIds[1]}, ${storeIds[2]})`;
      if (masterIds.length > 0) {
        await tx.$executeRaw`DELETE FROM product_synonyms WHERE product_id IN (${Prisma.join(masterIds)})`;
        await tx.$executeRaw`DELETE FROM master_products WHERE id IN (${Prisma.join(masterIds)})`;
      }
      const runEmails = [emails.ownerA, emails.ownerB];
      const found = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE email IN (${Prisma.join(runEmails)})
      `;
      const userIds = [
        ...new Set([
          ...[ids.ownerA, ids.ownerB].filter((id) => id.length > 0),
          ...found.map((row) => row.id),
        ]),
      ];
      if (userIds.length > 0) {
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id IN (${Prisma.join(userIds)})`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id IN (${Prisma.join(userIds)})`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id IN (${Prisma.join(userIds)})`;
        await tx.$executeRaw`DELETE FROM users WHERE id IN (${Prisma.join(userIds)})`;
      }
      const verificationMatch = [
        ...runEmails.map((email) => Prisma.sql`value LIKE ${`%${email}%`} OR identifier LIKE ${`%${email}%`}`),
        ...userIds.map((id) => Prisma.sql`value = ${id} OR identifier = ${id}`),
      ];
      if (verificationMatch.length > 0) {
        await tx.$executeRaw`DELETE FROM verifications WHERE ${Prisma.join(verificationMatch, " OR ")}`;
      }
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${storeIds[0]}, ${storeIds[1]}, ${storeIds[2]})`;
    }, { timeout: 60_000 });
  }, 120_000);

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    restoreServiceAndCacheDoubles();
  });

  afterEach(() => {
    restoreServiceAndCacheDoubles();
    consoleSpy?.mockRestore();
  });

  it("runs as app_runtime with a real owner session", async () => {
    const who = (await healthQueryRaw`SELECT current_user`) as Array<{ current_user: string }>;
    expect(who[0]?.current_user).toBe("app_runtime");
    asStore(storeASlug, cookies.ownerA);
    const session = await auth.api.getSession({
      headers: await headers(),
      query: { disableCookieCache: true },
    });
    expect(session?.user.id).toBe(ids.ownerA);
    expect(session?.user.twoFactorEnabled).toBe(true);
  });

  it("unknown token returns the invalid-token message verbatim", async () => {
    const before = await fiveTables(storeAId);
    const res = await commitAs(storeASlug, cookies.ownerA, crypto.randomUUID(), newItems([2]));
    expectVerbatim(res, INVALID);
    expect(await fiveTables(storeAId)).toEqual(before);
  });

  it("expired token returns the expired message verbatim and stays pending", async () => {
    const name = `Expired Yam ${RUN}`;
    const preview = await previewCsv(storeCSlug, cookies.ownerA, priceCsv(name));
    expect(preview.newItems.map((item) => item.csvName)).toEqual([name]);
    await backdate(preview.importToken, 31 * 60 * 1000);
    const before = await fiveTables(storeCId);
    const res = await commitAs(storeCSlug, cookies.ownerA, preview.importToken, newItems([2]));
    expectVerbatim(res, EXPIRED);
    const token = await tokenRow(storeCId, preview.importToken);
    expect(token?.status).toBe("pending");
    expect(token?.committedAt).toBeNull();
    expect(await fiveTables(storeCId)).toEqual(before);
  });

  it("second commit returns already committed and revalidates once", async () => {
    const name = `Second ${RUN}`;
    const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(name));
    const first = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2]));
    expect(first.error).toBeUndefined();
    expect(first.result?.createdCount).toBe(1);
    expect(revalidateTagMock).toHaveBeenCalledTimes(1);
    const second = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2]));
    expect(second.error).toBe(ALREADY_COMMITTED);
    expect(second.result).toBeUndefined();
    expect(csvImportLogs()).toEqual([]);
    expect(revalidateTagMock).toHaveBeenCalledTimes(1);
    expect(await storeScoped(storeAId).listing.count({ where: { customName: name } })).toBe(1);
    expect((await tokenRow(storeAId, preview.importToken))?.status).toBe("committed");
  });

  it("empty selection returns no rows selected", async () => {
    const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(`Empty ${RUN}`));
    const before = await fiveTables(storeAId);
    const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, EMPTY);
    expectVerbatim(res, NO_ROWS);
    expect((await tokenRow(storeAId, preview.importToken))?.status).toBe("pending");
    expect(await fiveTables(storeAId)).toEqual(before);
  });

  it("out-of-range rows return no valid rows", async () => {
    const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(`Range ${RUN}`));
    const before = await fiveTables(storeAId);
    const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([0, -1, 999999]));
    expectVerbatim(res, NO_VALID);
    expect((await tokenRow(storeAId, preview.importToken))?.status).toBe("pending");
    expect(await fiveTables(storeAId)).toEqual(before);
  });

  it("5001 out-of-range rows return no valid rows without a write", async () => {
    const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(`Max ${RUN}`));
    const before = await fiveTables(storeAId);
    const rows = Array.from({ length: 5001 }, (_, index) => 10_000 + index);
    const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems(rows));
    expectVerbatim(res, NO_VALID);
    expect(await fiveTables(storeAId)).toEqual(before);
  });

  it("ambiguous row as a new item returns the Row message", async () => {
    const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(SYNONYM));
    expect(preview.ambiguous.map((row) => row.csvName)).toEqual([SYNONYM]);
    const before = await fiveTables(storeAId);
    const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2]));
    expectVerbatim(
      res,
      `Row 2 ("${SYNONYM}") matches multiple master products. Use ambiguous resolutions to pick one.`,
    );
    expect(res.error).not.toContain(storeAId);
    expect(await fiveTables(storeAId)).toEqual(before);
  });

  it("unknown resolution product returns the Resolution message", async () => {
    const madeUp = `missing-product-${RUN}`;
    const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(SYNONYM, "8.00"));
    expect(preview.ambiguous).toHaveLength(1);
    const before = await fiveTables(storeAId);
    const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, {
      matchedRows: [],
      newItemRows: [],
      ambiguousResolutions: [{ row: 2, masterProductId: madeUp }],
    });
    expectVerbatim(res, `Resolution for row 2 references product ${madeUp} which is not in the match list.`);
    expect(res.error).not.toContain(storeAId);
    expect(await fiveTables(storeAId)).toEqual(before);
  });

  it("all selected already listed returns the message and leaves the token pending", async () => {
    const name = `Listed Yam ${RUN}`;
    const first = await previewCsv(storeASlug, cookies.ownerA, priceCsv(name));
    const committed = await commitAs(storeASlug, cookies.ownerA, first.importToken, newItems([2]));
    expect(committed.result?.createdCount).toBe(1);
    revalidateTagMock.mockClear();
    consoleSpy?.mockClear();
    const second = await previewCsv(storeASlug, cookies.ownerA, priceCsv(name, "5.00"));
    expect(second.alreadyListed.map((row) => row.csvName)).toEqual([name]);
    const before = await fiveTables(storeAId);
    const res = await commitAs(storeASlug, cookies.ownerA, second.importToken, newItems([2]));
    expectVerbatim(res, ALREADY_LISTED);
    const token = await tokenRow(storeAId, second.importToken);
    expect(token?.status).toBe("pending");
    expect(token?.committedAt).toBeNull();
    expect(await fiveTables(storeAId)).toEqual(before);
  });

  it("already-listed rollback preserves committedAt and all commit tables", async () => {
    const name = `Rollback Yam ${RUN}`;
    const first = await previewCsv(storeASlug, cookies.ownerA, priceCsv(name));
    expect((await commitAs(storeASlug, cookies.ownerA, first.importToken, newItems([2]))).result?.createdCount).toBe(1);
    revalidateTagMock.mockClear();
    consoleSpy?.mockClear();
    const second = await previewCsv(storeASlug, cookies.ownerA, priceCsv(name, "6.00"));
    const before = await fiveTables(storeAId);
    const res = await commitAs(storeASlug, cookies.ownerA, second.importToken, newItems([2]));
    expectVerbatim(res, ALREADY_LISTED);
    const token = await tokenRow(storeAId, second.importToken);
    expect(token?.status).toBe("pending");
    expect(token?.committedAt).toBeNull();
    expect(await fiveTables(storeAId)).toEqual(before);
    expect(await storeScoped(storeAId).listing.count({ where: { customName: name } })).toBe(1);
  });

  it("a row selected twice creates one listing", async () => {
    const name = `Twice ${RUN}`;
    const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(name));
    const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, {
      matchedRows: [2, 2],
      newItemRows: [2, 2],
      ambiguousResolutions: [],
    });
    expect(res.error).toBeUndefined();
    expect(res.result?.createdCount).toBe(1);
    expect(res.result?.listingIds).toHaveLength(1);
    expect(await storeScoped(storeAId).listing.count({ where: { customName: name } })).toBe(1);
    expect(revalidateTagMock).toHaveBeenCalledTimes(1);
  });

  it("real database error is replaced and logged once", async () => {
    let captured: unknown;
    let rejected = false;
    try {
      await storeScoped(storeBId).listingImport.create({
        data: {
          id: crypto.randomUUID(),
          storeId: storeAId,
          csvText: "name,price\nleak,1.00\n",
          rowCount: 1,
          status: "pending",
          createdById: ids.ownerA,
        },
      });
    } catch (error) {
      rejected = true;
      captured = error;
    }
    expect(rejected).toBe(true);
    const message = captured instanceof Error ? captured.message : String(captured);
    expect(message).toContain("listing_imports");
    expect(message).toMatch(/42501|row-level security/i);
    const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(`Db Leak ${RUN}`));
    const before = await fiveTables(storeAId);
    commitImportMock.mockRejectedValueOnce(captured);
    const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2]));
    expectGeneric(res, captured, storeAId);
    expect(await fiveTables(storeAId)).toEqual(before);
    expect((await tokenRow(storeAId, preview.importToken))?.status).toBe("pending");
  });

  it("allowed prefix mid-string, lowercase, string and object throws are generic", async () => {
    const thrownValues: unknown[] = [
      new Error("Error: Import token is invalid"),
      new Error("import token is invalid"),
      "Import token x",
      { message: "Import token x" },
    ];
    for (const thrown of thrownValues) {
      consoleSpy?.mockClear();
      revalidateTagMock.mockClear();
      commitImportMock.mockRejectedValueOnce(thrown);
      const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(`Generic ${crypto.randomUUID()}`));
      const before = await fiveTables(storeAId);
      const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2]));
      expectGeneric(res, thrown, storeAId);
      expect(await fiveTables(storeAId)).toEqual(before);
    }
  });

  it("the commitImport double is back to the real function after an override", async () => {
    commitImportMock.mockRejectedValueOnce(new Error("consumed leak"));
    const burned = await previewCsv(storeASlug, cookies.ownerA, priceCsv(`Burned ${RUN}`));
    const failed = await commitAs(storeASlug, cookies.ownerA, burned.importToken, newItems([2]));
    expect(failed.error).toBe(GENERIC);
    restoreServiceAndCacheDoubles();
    consoleSpy?.mockClear();
    const name = `Restored ${RUN}`;
    const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(name));
    const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2]));
    expect(res.error).toBeUndefined();
    expect(res.result?.createdCount).toBe(1);
    expect(await storeScoped(storeAId).listing.count({ where: { customName: name } })).toBe(1);
    expect(revalidateTagMock).toHaveBeenCalledTimes(1);
    expect(revalidateTagMock).toHaveBeenCalledWith(`storefront:${storeAId}`, { expire: 0 });
  });

  it("cleanup discards unconsumed service and cache overrides", async () => {
    commitImportMock.mockRejectedValueOnce(new Error("unconsumed service"));
    revalidateTagMock.mockImplementationOnce(() => {
      throw new Error("unconsumed cache");
    });
    restoreServiceAndCacheDoubles();
    consoleSpy?.mockClear();
    const name = `Unconsumed ${RUN}`;
    const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(name));
    const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2]));
    expect(res.error).toBeUndefined();
    expect(res.result?.createdCount).toBe(1);
    expect(csvImportLogs()).toEqual([]);
    expect(revalidateTagMock).toHaveBeenCalledTimes(1);
    expect(revalidateTagMock).toHaveBeenCalledWith(`storefront:${storeAId}`, { expire: 0 });
    expect((await tokenRow(storeAId, preview.importToken))?.status).toBe("committed");
  });

  it("cache invalidation failure after commit still returns the result", async () => {
    const left = `Palm ${RUN}`;
    const right = `Egusi ${RUN}`;
    const preview = await previewCsv(
      storeASlug,
      cookies.ownerA,
      countedCsv([
        [left, "4.50", 3],
        [right, "8.00", 5],
      ]),
    );
    expect(preview.newItems.map((item) => item.csvName)).toEqual([left, right]);
    const thrown = cacheInvariant(storeAId);
    revalidateTagMock.mockImplementation(() => {
      throw thrown;
    });
    const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2, 3]));
    expect(res.error).toBeUndefined();
    expect(res.result?.createdCount).toBe(2);
    expect(res.result?.listingIds).toHaveLength(2);
    const logs = csvImportLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.[0]).toBe(REVALIDATE_LOG);
    expect(logs[0]?.[1]).toBe(thrown);
    const tables = await fiveTables(storeAId);
    const listings = tables.listings.filter((row) => row.customName === left || row.customName === right);
    expect(listings).toHaveLength(2);
    expect(listings.map((row) => row.id).sort()).toEqual([...(res.result?.listingIds ?? [])].sort());
    const listingIds = new Set(listings.map((row) => row.id));
    expect(tables.variants.filter((row) => listingIds.has(row.listingId))).toHaveLength(2);
    const stock = tables.stock.filter((row) => listingIds.has(row.listingId));
    expect(stock.map((row) => row.delta).sort((a, b) => a - b)).toEqual([3, 5]);
    const audits = tables.audits.filter((row) => row.action === "catalog.csv_import" && importIdOf(row.after) === preview.importToken);
    expect(audits).toHaveLength(1);
    const token = await tokenRow(storeAId, preview.importToken);
    expect(token?.status).toBe("committed");
    expect(token?.committedAt).not.toBeNull();
    consoleSpy?.mockClear();
    const retry = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2, 3]));
    expect(retry.error).toBe(ALREADY_COMMITTED);
    expect(retry.result).toBeUndefined();
    expect(csvImportLogs()).toEqual([]);
    expect(await storeScoped(storeAId).listing.count({ where: { customName: { in: [left, right] } } })).toBe(2);
  });

  it("retry after a cache failure returns already committed with no duplicates", async () => {
    const name = `Retry ${RUN}`;
    const preview = await previewCsv(storeASlug, cookies.ownerA, countedCsv([[name, "4.50", 3]]));
    revalidateTagMock.mockImplementation(() => {
      throw cacheInvariant(storeAId);
    });
    const first = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2]));
    expect(first.result?.createdCount).toBe(1);
    const auditsBefore = await storeScoped(storeAId).auditLog.count({
      where: { action: "catalog.csv_import" },
    });
    consoleSpy?.mockClear();
    const retry = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2]));
    expect(retry.error).toBe(ALREADY_COMMITTED);
    expect(await storeScoped(storeAId).listing.count({ where: { customName: name } })).toBe(1);
    expect(await storeScoped(storeAId).auditLog.count({ where: { action: "catalog.csv_import" } })).toBe(auditsBefore);
    expect(csvImportLogs().some((call) => call[0] === COMMIT_LOG)).toBe(false);
  });

  it("non-Error thrown by cache invalidation still returns the result", async () => {
    const name = `Boom ${RUN}`;
    const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(name));
    revalidateTagMock.mockImplementation(() => {
      throw "boom";
    });
    const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2]));
    expect(res.error).toBeUndefined();
    expect(res.result?.createdCount).toBe(1);
    const logs = csvImportLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.[0]).toBe(REVALIDATE_LOG);
    expect(logs[0]?.[1]).toBe("boom");
    expect((await tokenRow(storeAId, preview.importToken))?.status).toBe("committed");
  });

  async function isolateAfterCommit(name: string): Promise<void> {
    const preview = await previewCsv(storeASlug, cookies.ownerA, countedCsv([[name, "4.50", 4]]));
    revalidateTagMock.mockImplementation(() => {
      throw cacheInvariant(storeAId);
    });
    const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2]));
    expect(res.result?.createdCount).toBe(1);
    const listingId = res.result!.listingIds[0]!;
    const tables = await fiveTables(storeAId);
    const listing = tables.listings.find((row) => row.id === listingId);
    const variant = tables.variants.find((row) => row.listingId === listingId);
    const stock = tables.stock.find((row) => row.listingId === listingId);
    const audit = tables.audits.find((row) => importIdOf(row.after) === preview.importToken);
    expect(listing).toBeTruthy();
    expect(variant).toBeTruthy();
    expect(stock).toBeTruthy();
    expect(audit).toBeTruthy();
    const known = {
      importId: preview.importToken,
      listingId,
      variantId: variant!.id,
      stockId: stock!.id,
      auditId: audit!.id,
    };
    const readable = storeScoped(storeAId);
    expect(await readable.listingImport.findUnique({ where: { id: known.importId } })).not.toBeNull();
    expect(await readable.listing.findUnique({ where: { id: known.listingId } })).not.toBeNull();
    expect(await readable.listingVariant.findUnique({ where: { id: known.variantId } })).not.toBeNull();
    expect(await readable.stockEvent.findUnique({ where: { id: known.stockId } })).not.toBeNull();
    expect(await readable.auditLog.findUnique({ where: { id: known.auditId } })).not.toBeNull();
    const hidden = storeScoped(storeBId);
    expect(await hidden.listingImport.findUnique({ where: { id: known.importId } })).toBeNull();
    expect(await hidden.listing.findUnique({ where: { id: known.listingId } })).toBeNull();
    expect(await hidden.listingVariant.findUnique({ where: { id: known.variantId } })).toBeNull();
    expect(await hidden.stockEvent.findUnique({ where: { id: known.stockId } })).toBeNull();
    expect(await hidden.auditLog.findUnique({ where: { id: known.auditId } })).toBeNull();
    expect((await hidden.listingImport.updateMany({ where: { id: known.importId }, data: { status: "tampered" } })).count).toBe(0);
    expect((await hidden.listing.updateMany({ where: { id: known.listingId }, data: { price: 1 } })).count).toBe(0);
    expect((await hidden.listingVariant.updateMany({ where: { id: known.variantId }, data: { price: 1 } })).count).toBe(0);
    expect((await hidden.stockEvent.updateMany({ where: { id: known.stockId }, data: { delta: 0 } })).count).toBe(0);
    expect((await hidden.auditLog.updateMany({ where: { id: known.auditId }, data: { action: "tampered" } })).count).toBe(0);
    expect((await hidden.listingImport.deleteMany({ where: { id: known.importId } })).count).toBe(0);
    expect((await hidden.listing.deleteMany({ where: { id: known.listingId } })).count).toBe(0);
    expect((await hidden.listingVariant.deleteMany({ where: { id: known.variantId } })).count).toBe(0);
    expect((await hidden.stockEvent.deleteMany({ where: { id: known.stockId } })).count).toBe(0);
    expect((await hidden.auditLog.deleteMany({ where: { id: known.auditId } })).count).toBe(0);
    await expect(hidden.listingImport.create({
      data: {
        id: crypto.randomUUID(),
        storeId: storeAId,
        csvText: "name,price\nprobe,1.00\n",
        rowCount: 1,
        status: "pending",
        createdById: ids.ownerA,
      },
    })).rejects.toThrow(/42501|row-level security/i);
    await expect(hidden.listing.create({
      data: {
        id: crypto.randomUUID(),
        storeId: storeAId,
        customName: `Probe ${crypto.randomUUID()}`,
        price: 100,
        stockMode: "status",
      },
    })).rejects.toThrow(/42501|row-level security/i);
    await expect(hidden.listingVariant.create({
      data: {
        id: crypto.randomUUID(),
        listingId: known.listingId,
        label: "Probe",
        price: 100,
        weightG: 100,
      },
    })).rejects.toThrow(/42501|row-level security/i);
    await expect(hidden.stockEvent.create({
      data: {
        id: crypto.randomUUID(),
        storeId: storeAId,
        listingId: known.listingId,
        type: "recount",
        delta: 1,
        actorId: ids.ownerA,
      },
    })).rejects.toThrow(/42501|row-level security/i);
    await expect(hidden.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        storeId: storeAId,
        actorId: ids.ownerA,
        actorEmail: emails.ownerA,
        action: "catalog.csv_import",
        entityType: "listing",
        entityId: known.listingId,
      },
    })).rejects.toThrow(/42501|row-level security/i);
    const after = await fiveTables(storeAId);
    expect(after.imports.find((row) => row.id === known.importId)).toEqual(tables.imports.find((row) => row.id === known.importId));
    expect(after.listings.find((row) => row.id === known.listingId)).toEqual(listing);
    expect(after.variants.find((row) => row.id === known.variantId)).toEqual(variant);
    expect(after.stock.find((row) => row.id === known.stockId)).toEqual(stock);
    expect(after.audits.find((row) => row.id === known.auditId)).toEqual(audit);
    expect(await readable.listing.findUnique({ where: { id: known.listingId } })).not.toBeNull();
  }

  it("storeScoped(B) cannot read, change or insert A's commit rows after a cache failure", async () => {
    await isolateAfterCommit(`Hidden ${RUN}`);
  });

  it("cross-store probes target existing commit rows with valid writes", async () => {
    await isolateAfterCommit(`Probe ${RUN}`);
  });

  it("cache invalidation runs once on success with the store tag and expire 0", async () => {
    const name = `Tagged ${RUN}`;
    const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(name));
    const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2]));
    expect(res.error).toBeUndefined();
    expect(res.result?.createdCount).toBe(1);
    expect(revalidateTagMock).toHaveBeenCalledTimes(1);
    expect(revalidateTagMock).toHaveBeenCalledWith(`storefront:${storeAId}`, { expire: 0 });
    expect(csvImportLogs()).toEqual([]);
  });

  it("missing token returns the message without calling commitImport", async () => {
    const callsBefore = commitImportMock.mock.calls.length;
    const before = await fiveTables(storeAId);
    const res = await commitAs(storeASlug, cookies.ownerA, "", EMPTY);
    expect(res.error).toBe(MISSING);
    expect(res.result).toBeUndefined();
    expect(commitImportMock.mock.calls.length).toBe(callsBefore);
    expect(revalidateTagMock).not.toHaveBeenCalled();
    expect(csvImportLogs()).toEqual([]);
    expect(await fiveTables(storeAId)).toEqual(before);
  });

  it("revalidation observes the real commit promise fulfilled", async () => {
    let fulfilled = false;
    let observedWhileFulfilled = false;
    const real = actualBox.commitImport;
    if (!real) throw new Error("real commitImport was not captured");
    commitImportMock.mockImplementation(async (storeId, token, selection, actor) => {
      const result = await real(storeId, token, selection, actor);
      fulfilled = true;
      return result;
    });
    revalidateTagMock.mockImplementation(() => {
      observedWhileFulfilled = fulfilled;
    });
    const name = `Ordered ${RUN}`;
    const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(name));
    const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2]));
    expect(res.result?.createdCount).toBe(1);
    expect(fulfilled).toBe(true);
    expect(observedWhileFulfilled).toBe(true);
    expect(revalidateTagMock).toHaveBeenCalledTimes(1);
  });

  it("parallel commits of one token: one result, one already committed", async () => {
    const name = `Parallel ${RUN}`;
    const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(name));
    const gate = openWhenBothArrive();
    const real = actualBox.commitImport;
    if (!real) throw new Error("real commitImport was not captured");
    commitImportMock.mockImplementation(async (storeId, token, selection, actor) => {
      try {
        await gate.enter();
        return await real(storeId, token, selection, actor);
      } finally {
        gate.release();
      }
    });
    const headers = headersFor(storeASlug, cookies.ownerA);
    const [first, second] = await Promise.all([
      inStore(headers, () => csvCommitAction(preview.importToken, newItems([2]))),
      inStore(headers, () => csvCommitAction(preview.importToken, newItems([2]))),
    ]);
    expect(gate.arrived()).toBe(2);
    const results = [first, second];
    expect(results.filter((row) => row.result).length).toBe(1);
    expect(results.filter((row) => row.error === ALREADY_COMMITTED).length).toBe(1);
    expect(results.some((row) => row.error === GENERIC)).toBe(false);
    expect(revalidateTagMock).toHaveBeenCalledTimes(1);
    expect(revalidateTagMock).toHaveBeenCalledWith(`storefront:${storeAId}`, { expire: 0 });
    expect(await storeScoped(storeAId).listing.count({ where: { customName: name } })).toBe(1);
    const audits = await storeScoped(storeAId).auditLog.findMany({ where: { action: "catalog.csv_import" } });
    expect(audits.filter((row) => importIdOf(row.after) === preview.importToken)).toHaveLength(1);
  }, 30_000);

  it("contending commits preserve one success when winner revalidation throws", async () => {
    const name = `Contend ${RUN}`;
    const preview = await previewCsv(storeASlug, cookies.ownerA, countedCsv([[name, "4.50", 2]]));
    const gate = openWhenBothArrive();
    const real = actualBox.commitImport;
    if (!real) throw new Error("real commitImport was not captured");
    const thrown = cacheInvariant(storeAId);
    commitImportMock.mockImplementation(async (storeId, token, selection, actor) => {
      try {
        await gate.enter();
        return await real(storeId, token, selection, actor);
      } finally {
        gate.release();
      }
    });
    revalidateTagMock.mockImplementation(() => {
      throw thrown;
    });
    const headers = headersFor(storeASlug, cookies.ownerA);
    const results = await Promise.all([
      inStore(headers, () => csvCommitAction(preview.importToken, newItems([2]))),
      inStore(headers, () => csvCommitAction(preview.importToken, newItems([2]))),
    ]);
    expect(gate.arrived()).toBe(2);
    expect(results.filter((row) => row.result?.createdCount === 1)).toHaveLength(1);
    expect(results.filter((row) => row.error === ALREADY_COMMITTED)).toHaveLength(1);
    expect(revalidateTagMock).toHaveBeenCalledTimes(1);
    const logs = csvImportLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.[0]).toBe(REVALIDATE_LOG);
    expect(logs[0]?.[1]).toBe(thrown);
    expect(await storeScoped(storeAId).listing.count({ where: { customName: name } })).toBe(1);
    const tables = await fiveTables(storeAId);
    expect(tables.imports.find((row) => row.id === preview.importToken)?.status).toBe("committed");
    expect(tables.audits.filter((row) => importIdOf(row.after) === preview.importToken)).toHaveLength(1);
    expect(tables.stock.filter((row) => row.delta === 2)).toHaveLength(1);
  }, 30_000);

  it("concurrent stores keep cache tags and results isolated when A revalidation throws", async () => {
    const nameA = `Store A ${RUN} ${crypto.randomUUID()}`;
    const nameB = `Store B ${RUN} ${crypto.randomUUID()}`;
    const previewA = await previewCsv(storeASlug, cookies.ownerA, priceCsv(nameA));
    const previewB = await previewCsv(storeBSlug, cookies.ownerB, priceCsv(nameB));
    const gate = openWhenBothArrive();
    const real = actualBox.commitImport;
    if (!real) throw new Error("real commitImport was not captured");
    commitImportMock.mockImplementation(async (storeId, token, selection, actor) => {
      try {
        await gate.enter();
        return await real(storeId, token, selection, actor);
      } finally {
        gate.release();
      }
    });
    revalidateTagMock.mockImplementation((tag: string) => {
      if (tag === `storefront:${storeAId}`) throw cacheInvariant(storeAId);
    });
    const [resultA, resultB] = await Promise.all([
      inStore(headersFor(storeASlug, cookies.ownerA), () => csvCommitAction(previewA.importToken, newItems([2]))),
      inStore(headersFor(storeBSlug, cookies.ownerB), () => csvCommitAction(previewB.importToken, newItems([2]))),
    ]);
    expect(gate.arrived()).toBe(2);
    expect(resultA.error).toBeUndefined();
    expect(resultA.result?.createdCount).toBe(1);
    expect(resultB.error).toBeUndefined();
    expect(resultB.result?.createdCount).toBe(1);
    expect(revalidateTagMock).toHaveBeenCalledTimes(2);
    expect(revalidateTagMock).toHaveBeenCalledWith(`storefront:${storeAId}`, { expire: 0 });
    expect(revalidateTagMock).toHaveBeenCalledWith(`storefront:${storeBId}`, { expire: 0 });
    const logs = csvImportLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.[0]).toBe(REVALIDATE_LOG);
    expect(logs[0]?.[1]).toBeInstanceOf(Error);
    expect((logs[0]?.[1] as Error).message).toContain(storeAId);
    expect((logs[0]?.[1] as Error).message).not.toContain(storeBId);
    const listingA = await storeScoped(storeAId).listing.findFirst({ where: { customName: nameA } });
    const listingB = await storeScoped(storeBId).listing.findFirst({ where: { customName: nameB } });
    expect(listingA?.id).toBe(resultA.result?.listingIds[0]);
    expect(listingB?.id).toBe(resultB.result?.listingIds[0]);
    expect(await storeScoped(storeBId).listing.findFirst({ where: { customName: nameA } })).toBeNull();
    expect(await storeScoped(storeAId).listing.findFirst({ where: { customName: nameB } })).toBeNull();
    const auditA = await storeScoped(storeAId).auditLog.findFirst({
      where: { action: "catalog.csv_import", entityId: listingA!.id },
    });
    const auditB = await storeScoped(storeBId).auditLog.findFirst({
      where: { action: "catalog.csv_import", entityId: listingB!.id },
    });
    expect(auditA?.actorId).toBe(ids.ownerA);
    expect(auditB?.actorId).toBe(ids.ownerB);
  }, 30_000);

  it("token time limit at 29 and 31 minutes, same under America/Denver", async () => {
    async function ageCase(label: string, ageMs: number, zone: "plain" | "America/Denver") {
      const name = `${label} ${zone} ${RUN}`;
      const preview = await previewCsv(storeCSlug, cookies.ownerA, priceCsv(name));
      await backdate(preview.importToken, ageMs);
      const run = () => commitAs(storeCSlug, cookies.ownerA, preview.importToken, newItems([2]));
      const res = zone === "plain" ? await run() : await withSessionTimeZone("America/Denver", run);
      const token = await tokenRow(storeCId, preview.importToken);
      if (ageMs === 29 * 60 * 1000) {
        expect(res.error).toBeUndefined();
        expect(res.result?.createdCount).toBe(1);
        expect(token?.status).toBe("committed");
        expect(revalidateTagMock).toHaveBeenCalledWith(`storefront:${storeCId}`, { expire: 0 });
      } else {
        expectVerbatim(res, EXPIRED);
        expect(token?.status).toBe("pending");
        expect(token?.committedAt).toBeNull();
      }
      revalidateTagMock.mockClear();
      consoleSpy?.mockClear();
    }
    await ageCase("Fresh29", 29 * 60 * 1000, "plain");
    await ageCase("Stale31", 31 * 60 * 1000, "plain");
    await ageCase("Fresh29", 29 * 60 * 1000, "America/Denver");
    await ageCase("Stale31", 31 * 60 * 1000, "America/Denver");
  }, 60_000);

  it("overnight hours and money amounts are outside the import commit", async () => {
    const name = `Night Price ${RUN}`;
    const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(name, "4.50"));
    const ordersBefore = await storeScoped(storeAId).order.count();
    const res = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2]));
    expect(res.result?.createdCount).toBe(1);
    const listing = await storeScoped(storeAId).listing.findFirst({ where: { customName: name } });
    expect(listing?.price).toBe(450);
    expect(await storeScoped(storeAId).order.count()).toBe(ordersBefore);
  });

  it("commit action source keeps the allow-list and does not branch on Vercel or CI", () => {
    const source = readFileSync(new URL("./csv-import-actions.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export async function csvCommitAction"));
    expect(body).toContain("requireStoreOwner()");
    expect(body.indexOf("requireStoreOwner()")).toBeLessThan(body.indexOf("try"));
    expect(body).toContain("Missing import token. Please upload the file again.");
    expect(body).toContain("/^(Import token|This import|No rows|No valid|All selected|Resolution for|Row \\d)/");
    expect(body).toContain('"[csv-import] commit error:"');
    expect(body).toContain('"[csv-import] storefront revalidation failed:"');
    expect(body.indexOf("revalidateStorefront(session.store.id)")).toBeGreaterThan(body.indexOf('"[csv-import] commit error:"'));
    expect(body).not.toMatch(/process\.env\.(VERCEL|CI)\b/);
  });

  if (process.env.CSV_COMMIT_PROD_CHECK === "1") {
    it("production error mapping is unchanged with Vercel flags absent and present", async () => {
      expect(process.env.NODE_ENV).toBe("production");
      if (process.env.CSV_COMMIT_EXPECT_VERCEL === "1") {
        expect(process.env.VERCEL).toBe("1");
        expect(process.env.VERCEL_ENV).toBe("production");
      } else {
        expect(process.env.VERCEL).toBeUndefined();
        expect(process.env.VERCEL_ENV).toBeUndefined();
      }
      const unknown = await commitAs(storeASlug, cookies.ownerA, crypto.randomUUID(), newItems([2]));
      expectVerbatim(unknown, INVALID);
      const thrown = new Error("listing_imports secret 42501");
      commitImportMock.mockRejectedValueOnce(thrown);
      const preview = await previewCsv(storeASlug, cookies.ownerA, priceCsv(`Prod Generic ${crypto.randomUUID()}`));
      const generic = await commitAs(storeASlug, cookies.ownerA, preview.importToken, newItems([2]));
      expectGeneric(generic, thrown, storeAId);
      restoreServiceAndCacheDoubles();
      consoleSpy?.mockClear();
      const thrownCache = cacheInvariant(storeAId);
      revalidateTagMock.mockImplementation(() => {
        throw thrownCache;
      });
      const name = `Prod Cache ${crypto.randomUUID()}`;
      const cached = await previewCsv(storeASlug, cookies.ownerA, priceCsv(name));
      const ok = await commitAs(storeASlug, cookies.ownerA, cached.importToken, newItems([2]));
      expect(ok.error).toBeUndefined();
      expect(ok.result?.createdCount).toBe(1);
      const logs = csvImportLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.[0]).toBe(REVALIDATE_LOG);
      expect(logs[0]?.[1]).toBe(thrownCache);
      expect(ok.error ?? "").not.toContain("listing_imports");
    }, 60_000);
  }
});
