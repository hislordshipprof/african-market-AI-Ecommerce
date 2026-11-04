import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

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

import { headers } from "next/headers";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import {
  getAccessFallbackHTTPStatus,
  isHTTPAccessFallbackError,
} from "next/dist/client/components/http-access-fallback/http-access-fallback";
import { generateTOTP } from "../../../e2e/totp";
import { auth } from "../auth";
import { authPrisma, healthQueryRaw, platformAdmin, storeScoped } from "../db";
import { clearTestSentEmails, getTestSentEmails } from "../email/send";
import { csvCommitAction, csvPreviewAction } from "./csv-import-actions";
import type { CommitSelection, CsvPreviewResult } from "./csv-import";

// DATABASE_URL absent: the suite skips. Lane and hosted CI set it, so a real run skips 0.
// APP_RUNTIME_PASSWORD absent is not a skip: under NODE_ENV=test the app falls back to the
// owner URL and the current_user assertion fails. AUTH_RATE_LIMIT_RELAXED is set above,
// before auth is imported. next/navigation stays real.

const BASE = "http://localhost:3000/api/auth";
const RUN = `t222-${Date.now()}`;
const password = "ImportAuth-222!";
const USER_KEYS = [
  "ownerA",
  "ownerB",
  "ownerD",
  "staff",
  "challenge",
  "never",
  "turnedOff",
  "predates",
  "demote",
  "mixed",
  "flag",
  "revoke",
  "stranger",
  "admin",
  "customer",
  "intruder",
] as const;
type UserKey = (typeof USER_KEYS)[number];
const TOTP_KEYS: UserKey[] = [
  "ownerA",
  "ownerB",
  "ownerD",
  "staff",
  "challenge",
  "stranger",
  "admin",
  "demote",
  "mixed",
  "flag",
  "revoke",
];
const emails = Object.fromEntries(
  USER_KEYS.map((key) => [key, `${key.toLowerCase()}-${RUN}@example.com`]),
) as Record<UserKey, string>;
const EMPTY_SELECTION: CommitSelection = { matchedRows: [], newItemRows: [], ambiguousResolutions: [] };
const hasDb = !!process.env.DATABASE_URL;

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

  names(): string[] {
    return [...this.jar.keys()];
  }

  tamperSession(): CookieJar {
    const copy = new CookieJar();
    for (const [name, value] of this.jar) {
      const flipped = value.length > 0 && value.endsWith("a") ? "b" : "a";
      copy.jar.set(name, name.includes("session_token") ? `${value.slice(0, -1)}${flipped}` : value);
    }
    return copy;
  }
}

// Vitest honors asymmetricMatch at runtime. Its toThrow parameter type only lists Error.
function asExpectedError(matcher: {
  asymmetricMatch(received: unknown): boolean;
  toString(): string;
}): Error {
  return matcher as unknown as Error;
}

function redirectTo(url: string): Error {
  let actual = "no redirect";
  return asExpectedError({
    asymmetricMatch(received: unknown) {
      if (!isRedirectError(received)) {
        actual = received instanceof Error ? `${received.name}: ${received.message}` : String(received);
        return false;
      }
      actual = getURLFromRedirectError(received) ?? "null";
      return actual === url;
    },
    toString() {
      return `redirect to ${url} (saw ${actual})`;
    },
  });
}

const notFoundError = asExpectedError({
  asymmetricMatch(received: unknown) {
    return isHTTPAccessFallbackError(received) && getAccessFallbackHTTPStatus(received) === 404;
  },
  toString() {
    return "Next not-found 404";
  },
});

function signIn(slug: string): string {
  return `/store-admin/sign-in?store=${slug}`;
}

function staffHome(slug: string): string {
  return `/store-admin?store=${slug}`;
}

function countedFile(name: string): File {
  return new File([`name,price,qty\n${name},9.99,3\n`], "import.csv", { type: "text/csv" });
}

function formWith(file?: File | string): FormData {
  const form = new FormData();
  if (file !== undefined) form.set("file", file);
  return form;
}

function sizedCsv(name: string, bytes: number): File {
  const header = "name,price,notes\n";
  const prefix = `${name},9.99,`;
  const suffix = "\n";
  const pad = bytes - Buffer.byteLength(`${header}${prefix}${suffix}`);
  if (pad < 1) throw new Error(`no room for ${name} in ${bytes} bytes`);
  const body = `${header}${prefix}${"n".repeat(pad)}${suffix}`;
  if (Buffer.byteLength(body) !== bytes) throw new Error(`built ${Buffer.byteLength(body)} bytes`);
  return new File([body], "sized.csv", { type: "text/csv" });
}

function selectionOf(preview: CsvPreviewResult): CommitSelection {
  return {
    matchedRows: [],
    newItemRows: preview.newItems.map((item) => item.row),
    ambiguousResolutions: [],
  };
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

interface CatalogSnapshot {
  imports: unknown[];
  listings: unknown[];
  variants: unknown[];
  stock: unknown[];
  audits: unknown[];
  memberships: unknown[];
}

async function catalogSnapshot(storeId: string): Promise<CatalogSnapshot> {
  const scoped = storeScoped(storeId);
  const [imports, listings, stock, audits, memberships] = await Promise.all([
    scoped.listingImport.findMany({ orderBy: { id: "asc" } }),
    scoped.listing.findMany({ orderBy: { id: "asc" }, include: { variants: { orderBy: { id: "asc" } } } }),
    scoped.stockEvent.findMany({ orderBy: { id: "asc" } }),
    scoped.auditLog.findMany({ orderBy: { id: "asc" } }),
    scoped.storeMembership.findMany({ orderBy: { id: "asc" } }),
  ]);
  return {
    imports: imports.map((row) => ({
      id: row.id,
      status: row.status,
      csvText: row.csvText,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
      committedAt: row.committedAt?.toISOString() ?? null,
    })),
    listings: listings.map((row) => ({
      id: row.id,
      customName: row.customName,
      price: row.price,
      qty: row.qty,
      stockMode: row.stockMode,
      updatedAt: row.updatedAt.toISOString(),
    })),
    variants: listings.flatMap((row) =>
      row.variants.map((variant) => ({
        id: variant.id,
        listingId: variant.listingId,
        label: variant.label,
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
      actorId: row.actorId,
      actorEmail: row.actorEmail,
      action: row.action,
      entityId: row.entityId,
      after: row.after,
    })),
    memberships: memberships.map((row) => ({
      id: row.id,
      userId: row.userId,
      role: row.role,
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

async function tokenView(storeId: string, id: string) {
  const row = await storeScoped(storeId).listingImport.findUnique({ where: { id } });
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    csvText: row.csvText,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    committedAt: row.committedAt?.toISOString() ?? null,
  };
}

async function actorCounts(userId: string): Promise<{ imports: number; audits: number }> {
  const [imports, audits] = await Promise.all([
    platformAdmin.listingImport.count({ where: { createdById: userId } }),
    platformAdmin.auditLog.count({ where: { actorId: userId } }),
  ]);
  return { imports, audits };
}

interface AuthView {
  user: { id: string; email: string; twoFactorEnabled: boolean; role?: string };
  session: { id: string; twoFactorVerified: boolean };
}

async function authPost(path: string, body: unknown, cookies?: string): Promise<Response> {
  const requestHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies) requestHeaders.cookie = cookies;
  return auth.handler(new Request(`${BASE}${path}`, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) }));
}

async function authGet(url: string, cookies?: string): Promise<Response> {
  const requestHeaders: Record<string, string> = {};
  if (cookies) requestHeaders.cookie = cookies;
  return auth.handler(new Request(url, { headers: requestHeaders, redirect: "manual" }));
}

async function readSession(cookies: string): Promise<AuthView | null> {
  const res = await authGet(`${BASE}/get-session`, cookies || undefined);
  const text = await res.text();
  if (!text || text === "null") return null;
  let body: {
    user?: { id?: string; email?: string; twoFactorEnabled?: boolean; role?: string } | null;
    session?: { id?: string; twoFactorVerified?: boolean } | null;
  };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return null;
  }
  if (!body?.user?.id || !body.session) return null;
  return {
    user: {
      id: body.user.id,
      email: body.user.email ?? "",
      twoFactorEnabled: body.user.twoFactorEnabled === true,
      role: body.user.role,
    },
    session: {
      id: body.session.id ?? "",
      twoFactorVerified: body.session.twoFactorVerified === true,
    },
  };
}

async function sessionUserId(): Promise<string | null> {
  const reqHeaders = await headers();
  const session = await auth.api.getSession({ headers: reqHeaders, query: { disableCookieCache: true } });
  return session?.user.id ?? null;
}

const usedTotp = new Map<string, string>();

function totp(secret: string): string {
  const code = generateTOTP(secret);
  usedTotp.set(secret, code);
  return code;
}

async function nextTotp(secret: string): Promise<string> {
  const code = generateTOTP(secret);
  if (code !== usedTotp.get(secret)) return code;
  const waitMs = 30_000 - (Date.now() % 30_000) + 250;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const fresh = generateTOTP(secret);
  usedTotp.set(secret, fresh);
  return fresh;
}

describe.skipIf(!hasDb)("csv import actions: owner only (real auth, app_runtime)", () => {
  const storeAId = crypto.randomUUID();
  const storeBId = crypto.randomUUID();
  const storeDId = crypto.randomUUID();
  const storeEId = crypto.randomUUID();
  const storeASlug = `a-${RUN}`;
  const storeBSlug = `b-${RUN}`;
  const storeDSlug = `d-${RUN}`;
  const storeESlug = `e-${RUN}`;
  const missingSlug = `missing-${RUN}`;
  const ids = {} as Record<UserKey, string>;
  const cookies = {} as Record<UserKey, string>;
  const secrets = {} as Partial<Record<UserKey, string>>;
  let sharedToken = "";
  let sharedRow = 0;
  const sharedName = `Shared ${RUN}`;

  function sharedSelection(): CommitSelection {
    return { matchedRows: [], newItemRows: [sharedRow], ambiguousResolutions: [] };
  }

  async function signUp(email: string, name: string): Promise<CookieJar> {
    const jar = new CookieJar();
    const res = await authPost("/sign-up/email", { email, password, name });
    expect(res.status, await res.clone().text()).toBe(200);
    jar.apply(res);
    return jar;
  }

  async function enableVerified(email: string): Promise<{ jar: CookieJar; secret: string }> {
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
    return { jar, secret: secret! };
  }

  async function signInVerified(email: string, secret: string): Promise<CookieJar> {
    const jar = new CookieJar();
    const signedIn = await authPost("/sign-in/email", { email, password });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    jar.apply(signedIn);
    const body = (await signedIn.json()) as { twoFactorRedirect?: boolean };
    expect(body.twoFactorRedirect).toBe(true);
    const verified = await authPost("/two-factor/verify-totp", { code: await nextTotp(secret) }, jar.header());
    expect(verified.status, await verified.clone().text()).toBe(200);
    jar.apply(verified);
    return jar;
  }

  async function importCounted(slug: string, cookie: string, name: string) {
    asStore(slug, cookie);
    const preview = await csvPreviewAction(formWith(countedFile(name)));
    expect(preview.error).toBeUndefined();
    expect(preview.preview?.newItems.map((item) => item.csvName)).toEqual([name]);
    const token = preview.preview!.importToken;
    const committed = await csvCommitAction(token, selectionOf(preview.preview!));
    expect(committed.error).toBeUndefined();
    expect(committed.result?.createdCount).toBe(1);
    expect(committed.result?.listingIds).toHaveLength(1);
    return { token, listingId: committed.result!.listingIds[0]!, preview: preview.preview! };
  }

  async function loadSix(storeId: string, userId: string, email: string, name: string, token: string) {
    const listing = await storeScoped(storeId).listing.findFirst({
      where: { customName: name },
      include: { variants: true, stockEvents: true },
    });
    expect(listing).not.toBeNull();
    expect(listing!.price).toBe(999);
    expect(listing!.qty).toBe(3);
    expect(listing!.variants).toHaveLength(1);
    expect(listing!.variants[0]?.weightG).toBe(100);
    expect(listing!.variants[0]?.label).toBe("Default");
    expect(listing!.stockEvents).toHaveLength(1);
    expect(listing!.stockEvents[0]?.delta).toBe(3);
    expect(listing!.stockEvents[0]?.type).toBe("recount");
    expect(listing!.stockEvents[0]?.actorId).toBe(userId);
    const imported = await storeScoped(storeId).listingImport.findUnique({ where: { id: token } });
    expect(imported?.status).toBe("committed");
    expect(imported?.createdById).toBe(userId);
    const audits = await storeScoped(storeId).auditLog.findMany({
      where: { action: "catalog.csv_import", entityId: listing!.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorId).toBe(userId);
    expect(audits[0]?.actorEmail).toBe(email);
    expect(importIdOf(audits[0]?.after)).toBe(token);
    const membership = await storeScoped(storeId).storeMembership.findUnique({
      where: { storeId_userId: { storeId, userId } },
    });
    expect(membership?.role).toBe("owner");
    return {
      listingId: listing!.id,
      variantId: listing!.variants[0]!.id,
      stockId: listing!.stockEvents[0]!.id,
      importId: imported!.id,
      auditId: audits[0]!.id,
      membershipId: membership!.id,
      membershipStoreId: storeId,
      membershipUserId: userId,
    };
  }

  async function expectHidden(storeId: string, fixture: Awaited<ReturnType<typeof loadSix>>) {
    const scoped = storeScoped(storeId);
    expect(await scoped.listing.findUnique({ where: { id: fixture.listingId } })).toBeNull();
    expect(await scoped.listing.findMany({ where: { id: fixture.listingId } })).toEqual([]);
    expect(await scoped.listingVariant.findUnique({ where: { id: fixture.variantId } })).toBeNull();
    expect(await scoped.listingVariant.findMany({ where: { id: fixture.variantId } })).toEqual([]);
    expect(await scoped.stockEvent.findUnique({ where: { id: fixture.stockId } })).toBeNull();
    expect(await scoped.stockEvent.findMany({ where: { id: fixture.stockId } })).toEqual([]);
    expect(await scoped.auditLog.findUnique({ where: { id: fixture.auditId } })).toBeNull();
    expect(await scoped.auditLog.findMany({ where: { id: fixture.auditId } })).toEqual([]);
    expect(await scoped.listingImport.findUnique({ where: { id: fixture.importId } })).toBeNull();
    expect(await scoped.listingImport.findMany({ where: { id: fixture.importId } })).toEqual([]);
    expect(await scoped.storeMembership.findUnique({
      where: { storeId_userId: { storeId: fixture.membershipStoreId, userId: fixture.membershipUserId } },
    })).toBeNull();
    expect(await scoped.storeMembership.findMany({ where: { id: fixture.membershipId } })).toEqual([]);
    expect((await scoped.listing.updateMany({ where: { id: fixture.listingId }, data: { price: 1 } })).count).toBe(0);
    expect((await scoped.listingVariant.updateMany({ where: { id: fixture.variantId }, data: { price: 1 } })).count).toBe(0);
    expect((await scoped.stockEvent.updateMany({ where: { id: fixture.stockId }, data: { delta: 0 } })).count).toBe(0);
    expect((await scoped.auditLog.updateMany({ where: { id: fixture.auditId }, data: { action: "tampered" } })).count).toBe(0);
    expect((await scoped.listingImport.updateMany({ where: { id: fixture.importId }, data: { status: "tampered" } })).count).toBe(0);
    expect((await scoped.storeMembership.updateMany({ where: { id: fixture.membershipId }, data: { role: "staff" } })).count).toBe(0);
    expect((await scoped.listing.deleteMany({ where: { id: fixture.listingId } })).count).toBe(0);
    expect((await scoped.listingVariant.deleteMany({ where: { id: fixture.variantId } })).count).toBe(0);
    expect((await scoped.stockEvent.deleteMany({ where: { id: fixture.stockId } })).count).toBe(0);
    expect((await scoped.auditLog.deleteMany({ where: { id: fixture.auditId } })).count).toBe(0);
    expect((await scoped.listingImport.deleteMany({ where: { id: fixture.importId } })).count).toBe(0);
    expect((await scoped.storeMembership.deleteMany({ where: { id: fixture.membershipId } })).count).toBe(0);
  }

  async function expectDenied(input: {
    slug: string;
    cookie: string;
    url: string;
    csvName: string;
    token?: string;
    tokenStoreId?: string;
    selection?: CommitSelection;
    actorId?: string;
    watchStoreIds: string[];
    actorStartsAtZero?: boolean;
  }) {
    asStore(input.slug, input.cookie);
    const token = input.token ?? sharedToken;
    const tokenStoreId = input.tokenStoreId ?? storeAId;
    const selection = input.selection ?? sharedSelection();
    const tokenBefore = await tokenView(tokenStoreId, token);
    expect(tokenBefore?.status).toBe("pending");
    const actorBefore = input.actorId ? await actorCounts(input.actorId) : null;
    if (input.actorStartsAtZero && actorBefore) {
      expect(actorBefore.imports).toBe(0);
      expect(actorBefore.audits).toBe(0);
    }
    const previewBefore = await Promise.all(input.watchStoreIds.map((id) => catalogSnapshot(id)));
    await expect(csvPreviewAction(formWith(countedFile(input.csvName)))).rejects.toThrow(redirectTo(input.url));
    expect(await Promise.all(input.watchStoreIds.map((id) => catalogSnapshot(id)))).toEqual(previewBefore);
    if (actorBefore && input.actorId) expect(await actorCounts(input.actorId)).toEqual(actorBefore);
    expect(await tokenView(tokenStoreId, token)).toEqual(tokenBefore);

    const commitBefore = await Promise.all(input.watchStoreIds.map((id) => catalogSnapshot(id)));
    await expect(csvCommitAction(token, selection)).rejects.toThrow(redirectTo(input.url));
    expect(await Promise.all(input.watchStoreIds.map((id) => catalogSnapshot(id)))).toEqual(commitBefore);
    if (actorBefore && input.actorId) expect(await actorCounts(input.actorId)).toEqual(actorBefore);
    expect(await tokenView(tokenStoreId, token)).toEqual(tokenBefore);
    expect(await storeScoped(tokenStoreId).listing.findFirst({ where: { customName: input.csvName } })).toBeNull();
    expect(await storeScoped(tokenStoreId).listing.findFirst({ where: { customName: sharedName } })).toBeNull();
  }

  async function startChallenge(): Promise<CookieJar> {
    const jar = new CookieJar();
    const signedIn = await authPost("/sign-in/email", { email: emails.challenge, password });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    jar.apply(signedIn);
    const body = (await signedIn.json()) as { twoFactorRedirect?: boolean };
    expect(body.twoFactorRedirect).toBe(true);
    expect(jar.names().some((name) => name.includes("two_factor"))).toBe(true);
    expect(await readSession(jar.header())).toBeNull();
    return jar;
  }

  async function customerCookie(): Promise<string> {
    await authPrisma.session.deleteMany({ where: { userId: ids.customer } });
    clearTestSentEmails();
    const sent = await authPost("/sign-in/magic-link", { email: emails.customer, callbackURL: "/account" });
    expect(sent.status).toBe(200);
    const message = getTestSentEmails().find((item) => item.to === emails.customer);
    expect(message?.html).toBeTruthy();
    const href = message!.html.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
    expect(href).toBeTruthy();
    const jar = new CookieJar();
    const verify = await authGet(href!);
    expect(verify.status).toBeLessThan(400);
    jar.apply(verify);
    const session = await readSession(jar.header());
    expect(session?.user.id).toBe(ids.customer);
    expect(session?.user.twoFactorEnabled).toBe(false);
    expect(session?.session.twoFactorVerified).toBe(false);
    expect(session?.user.role ?? "customer").toBe("customer");
    return jar.header();
  }

  beforeAll(async () => {
    const signupJars = new Map<UserKey, CookieJar>();
    for (const key of USER_KEYS) signupJars.set(key, await signUp(emails[key], key));
    await Promise.all(USER_KEYS.map(async (key) => {
      const user = await authPrisma.user.findFirstOrThrow({ where: { email: emails[key] } });
      ids[key] = user.id;
    }));
    await authPrisma.user.update({ where: { id: ids.admin }, data: { role: "platform_admin" } });
    await authPrisma.user.update({ where: { id: ids.predates }, data: { twoFactorEnabled: true } });
    cookies.never = signupJars.get("never")!.header();
    cookies.predates = signupJars.get("predates")!.header();

    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      const stores: Array<[string, string, string]> = [
        [storeAId, `T222 A ${RUN}`, storeASlug],
        [storeBId, `T222 B ${RUN}`, storeBSlug],
        [storeDId, `T222 D ${RUN}`, storeDSlug],
        [storeEId, `T222 E ${RUN}`, storeESlug],
      ];
      for (const [id, name, slug] of stores) {
        await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${id}, ${name}, ${slug}, 'active', now())`;
      }
      const memberships: Array<[string, string, string]> = [
        [storeAId, ids.ownerA, "owner"],
        [storeBId, ids.ownerB, "owner"],
        [storeDId, ids.ownerD, "owner"],
        [storeEId, ids.revoke, "owner"],
        [storeAId, ids.staff, "staff"],
        [storeAId, ids.challenge, "owner"],
        [storeAId, ids.never, "owner"],
        [storeAId, ids.turnedOff, "owner"],
        [storeAId, ids.predates, "owner"],
        [storeAId, ids.demote, "owner"],
        [storeAId, ids.mixed, "owner"],
        [storeBId, ids.mixed, "staff"],
        [storeAId, ids.flag, "owner"],
      ];
      for (const [storeId, userId, role] of memberships) {
        await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${userId}, ${role}, now())`;
      }
    });

    for (const key of TOTP_KEYS) {
      const verified = await enableVerified(emails[key]);
      cookies[key] = verified.jar.header();
      secrets[key] = verified.secret;
    }

    asStore(storeASlug, cookies.ownerA);
    const preview = await csvPreviewAction(formWith(countedFile(sharedName)));
    expect(preview.error).toBeUndefined();
    sharedToken = preview.preview!.importToken;
    sharedRow = preview.preview!.newItems[0]!.row;
  }, 120_000);

  afterAll(async () => {
    const storeIds = [storeAId, storeBId, storeDId, storeEId];
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM listing_variants WHERE listing_id IN (SELECT id FROM listings WHERE store_id IN (${storeIds[0]}, ${storeIds[1]}, ${storeIds[2]}, ${storeIds[3]}))`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id IN (${storeIds[0]}, ${storeIds[1]}, ${storeIds[2]}, ${storeIds[3]})`;
      await tx.$executeRaw`DELETE FROM stock_events WHERE store_id IN (${storeIds[0]}, ${storeIds[1]}, ${storeIds[2]}, ${storeIds[3]})`;
      await tx.$executeRaw`DELETE FROM listings WHERE store_id IN (${storeIds[0]}, ${storeIds[1]}, ${storeIds[2]}, ${storeIds[3]})`;
      await tx.$executeRaw`DELETE FROM listing_imports WHERE store_id IN (${storeIds[0]}, ${storeIds[1]}, ${storeIds[2]}, ${storeIds[3]})`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE store_id IN (${storeIds[0]}, ${storeIds[1]}, ${storeIds[2]}, ${storeIds[3]})`;
      const emailLike = "%t222-%@example.com";
      await tx.$executeRaw`DELETE FROM two_factors WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${emailLike})`;
      await tx.$executeRaw`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${emailLike})`;
      await tx.$executeRaw`DELETE FROM accounts WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${emailLike})`;
      await tx.$executeRaw`DELETE FROM verifications WHERE value LIKE ${emailLike} OR value IN (SELECT id FROM users WHERE email LIKE ${emailLike})`;
      await tx.$executeRaw`DELETE FROM users WHERE email LIKE ${emailLike}`;
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${storeIds[0]}, ${storeIds[1]}, ${storeIds[2]}, ${storeIds[3]})`;
    }, { timeout: 60_000 });
  }, 120_000);

  it("runtime role is non-superuser and cannot bypass RLS", async () => {
    const rows = (await healthQueryRaw`
      SELECT current_user, r.rolsuper, r.rolbypassrls
      FROM pg_roles r
      WHERE r.rolname = current_user
    `) as Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.current_user).toBe("app_runtime");
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it("runs as app_runtime and the owner previews and commits", async () => {
    const who = (await healthQueryRaw`SELECT current_user`) as Array<{ current_user: string }>;
    expect(who[0]?.current_user).toBe("app_runtime");
    const session = await readSession(cookies.ownerA);
    expect(session?.user.id).toBe(ids.ownerA);
    expect(session?.user.twoFactorEnabled).toBe(true);
    expect(session?.session.twoFactorVerified).toBe(true);
    const name = `Control ${RUN}`;
    const imported = await importCounted(storeASlug, cookies.ownerA, name);
    const listing = await storeScoped(storeAId).listing.findFirst({ where: { customName: name } });
    expect(listing?.id).toBe(imported.listingId);
    const audits = await storeScoped(storeAId).auditLog.findMany({ where: { action: "catalog.csv_import", entityId: imported.listingId } });
    expect(audits).toHaveLength(1);
    expect((await tokenView(storeAId, sharedToken))?.status).toBe("pending");
  });

  it("signed out: preview and commit redirect to sign-in for the store", async () => {
    expect(await readSession("")).toBeNull();
    await expectDenied({
      slug: storeASlug,
      cookie: "",
      url: signIn(storeASlug),
      csvName: `Signed out ${RUN}`,
      watchStoreIds: [storeAId],
    });
  });

  it("two-factor cookie only: both redirect to sign-in", async () => {
    const jar = await startChallenge();
    await expectDenied({
      slug: storeASlug,
      cookie: jar.header(),
      url: signIn(storeASlug),
      csvName: `Challenge only ${RUN}`,
      actorId: ids.challenge,
      actorStartsAtZero: true,
      watchStoreIds: [storeAId],
    });
  });

  it("challenge-only cookie is denied and the same challenge can complete TOTP", async () => {
    const jar = await startChallenge();
    await expectDenied({
      slug: storeASlug,
      cookie: jar.header(),
      url: signIn(storeASlug),
      csvName: `Challenge complete ${RUN}`,
      actorId: ids.challenge,
      actorStartsAtZero: true,
      watchStoreIds: [storeAId],
    });
    const verified = await authPost("/two-factor/verify-totp", { code: await nextTotp(secrets.challenge!) }, jar.header());
    expect(verified.status, await verified.clone().text()).toBe(200);
    jar.apply(verified);
    const session = await readSession(jar.header());
    expect(session?.user.id).toBe(ids.challenge);
    expect(session?.user.twoFactorEnabled).toBe(true);
    expect(session?.session.twoFactorVerified).toBe(true);
  }, 60_000);

  it("owner who never enabled 2FA: both redirect to sign-in", async () => {
    const session = await readSession(cookies.never);
    expect(session?.user.id).toBe(ids.never);
    expect(session?.user.twoFactorEnabled).toBe(false);
    expect(session?.session.twoFactorVerified).toBe(false);
    expect((await storeScoped(storeAId).storeMembership.findUnique({
      where: { storeId_userId: { storeId: storeAId, userId: ids.never } },
    }))?.role).toBe("owner");
    await expectDenied({
      slug: storeASlug,
      cookie: cookies.never,
      url: signIn(storeASlug),
      csvName: `Never 2FA ${RUN}`,
      actorId: ids.never,
      actorStartsAtZero: true,
      watchStoreIds: [storeAId],
    });
  });

  it("owner who turned 2FA off keeps a verified session but is sent to sign-in", async () => {
    const verified = await enableVerified(emails.turnedOff);
    const disabled = await authPost("/two-factor/disable", { password }, verified.jar.header());
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    verified.jar.apply(disabled);
    const rotated = await readSession(verified.jar.header());
    expect(rotated?.user.id).toBe(ids.turnedOff);
    expect(rotated?.user.twoFactorEnabled).toBe(false);
    // Disable calls createSession(userId, false, oldSession). That spread is then
    // overwritten by session additional-field defaults, so twoFactorVerified is
    // false on the replacement. The brief's fallback is a verified session whose
    // user flag is cleared afterwards. That is the state that catches dropping
    // only !user.twoFactorEnabled.
    const again = await enableVerified(emails.turnedOff);
    await authPrisma.user.update({ where: { id: ids.turnedOff }, data: { twoFactorEnabled: false } });
    const session = await readSession(again.jar.header());
    expect(session?.user.id).toBe(ids.turnedOff);
    expect(session?.user.twoFactorEnabled).toBe(false);
    expect(session?.session.twoFactorVerified).toBe(true);
    await expectDenied({
      slug: storeASlug,
      cookie: again.jar.header(),
      url: signIn(storeASlug),
      csvName: `2FA off ${RUN}`,
      actorId: ids.turnedOff,
      actorStartsAtZero: true,
      watchStoreIds: [storeAId],
    });
  }, 45_000);

  it("owner whose session predates 2FA is sent to sign-in", async () => {
    const session = await readSession(cookies.predates);
    expect(session?.user.id).toBe(ids.predates);
    expect(session?.user.twoFactorEnabled).toBe(true);
    expect(session?.session.twoFactorVerified).toBe(false);
    await expectDenied({
      slug: storeASlug,
      cookie: cookies.predates,
      url: signIn(storeASlug),
      csvName: `Predates 2FA ${RUN}`,
      actorId: ids.predates,
      actorStartsAtZero: true,
      watchStoreIds: [storeAId],
    });
  });

  it("magic-link customer has a real session before both denials", async () => {
    const cookie = await customerCookie();
    await expectDenied({
      slug: storeASlug,
      cookie,
      url: signIn(storeASlug),
      csvName: `Customer session ${RUN}`,
      actorId: ids.customer,
      actorStartsAtZero: true,
      watchStoreIds: [storeAId],
    });
  });

  it("magic-link customer: both redirect to sign-in, nothing written", async () => {
    const cookie = await customerCookie();
    await expectDenied({
      slug: storeASlug,
      cookie,
      url: signIn(storeASlug),
      csvName: `Customer deny ${RUN}`,
      actorId: ids.customer,
      actorStartsAtZero: true,
      watchStoreIds: [storeAId],
    });
  });

  it("verified user with no membership: both redirect to sign-in", async () => {
    const session = await readSession(cookies.stranger);
    expect(session?.user.id).toBe(ids.stranger);
    expect(session?.user.twoFactorEnabled).toBe(true);
    expect(session?.session.twoFactorVerified).toBe(true);
    expect(await storeScoped(storeAId).storeMembership.findUnique({
      where: { storeId_userId: { storeId: storeAId, userId: ids.stranger } },
    })).toBeNull();
    await expectDenied({
      slug: storeASlug,
      cookie: cookies.stranger,
      url: signIn(storeASlug),
      csvName: `No membership ${RUN}`,
      actorId: ids.stranger,
      actorStartsAtZero: true,
      watchStoreIds: [storeAId],
    });
  });

  it("staff: both redirect to /store-admin for the store, nothing written", async () => {
    const session = await readSession(cookies.staff);
    expect(session?.user.id).toBe(ids.staff);
    expect(session?.user.twoFactorEnabled).toBe(true);
    expect(session?.session.twoFactorVerified).toBe(true);
    expect((await storeScoped(storeAId).storeMembership.findUnique({
      where: { storeId_userId: { storeId: storeAId, userId: ids.staff } },
    }))?.role).toBe("staff");
    await expectDenied({
      slug: storeASlug,
      cookie: cookies.staff,
      url: staffHome(storeASlug),
      csvName: `Staff deny ${RUN}`,
      actorId: ids.staff,
      actorStartsAtZero: true,
      watchStoreIds: [storeAId],
    });
  });

  it("staff over 2 MB gets the redirect, not the size message", async () => {
    asStore(storeASlug, cookies.staff);
    const before = await catalogSnapshot(storeAId);
    const pending = csvPreviewAction(formWith(sizedCsv(`Staff big ${RUN}`, 2_097_153)));
    await expect(pending).rejects.toThrow(redirectTo(staffHome(storeASlug)));
    expect(await catalogSnapshot(storeAId)).toEqual(before);
  });

  it("staff double submit leaves the token pending; owner commits once", async () => {
    const name = `Double ${RUN}`;
    asStore(storeASlug, cookies.ownerA);
    const ownerBefore = await actorCounts(ids.ownerA);
    const preview = await csvPreviewAction(formWith(countedFile(name)));
    expect(preview.error).toBeUndefined();
    const token = preview.preview!.importToken;
    const selection = selectionOf(preview.preview!);
    const pending = await tokenView(storeAId, token);
    expect(pending?.status).toBe("pending");
    asStore(storeASlug, cookies.staff);
    const staffBefore = await actorCounts(ids.staff);
    await expect(csvCommitAction(token, selection)).rejects.toThrow(redirectTo(staffHome(storeASlug)));
    await expect(csvCommitAction(token, selection)).rejects.toThrow(redirectTo(staffHome(storeASlug)));
    expect(await tokenView(storeAId, token)).toEqual(pending);
    expect(await actorCounts(ids.staff)).toEqual(staffBefore);
    asStore(storeASlug, cookies.ownerA);
    const committed = await csvCommitAction(token, selection);
    expect(committed.error).toBeUndefined();
    expect(committed.result?.createdCount).toBe(1);
    const audits = await storeScoped(storeAId).auditLog.findMany({ where: { action: "catalog.csv_import" } });
    expect(audits.filter((row) => importIdOf(row.after) === token)).toHaveLength(1);
    expect((await actorCounts(ids.ownerA)).audits).toBe(ownerBefore.audits + 1);
    const listing = await storeScoped(storeAId).listing.findFirst({ where: { customName: name } });
    expect(listing?.price).toBe(999);
    expect(listing?.qty).toBe(3);
  });

  it("staff commit of a committed token still redirects", async () => {
    const name = `Retry ${RUN}`;
    const imported = await importCounted(storeASlug, cookies.ownerA, name);
    expect((await tokenView(storeAId, imported.token))?.status).toBe("committed");
    asStore(storeASlug, cookies.staff);
    const before = await catalogSnapshot(storeAId);
    await expect(csvCommitAction(imported.token, selectionOf(imported.preview))).rejects.toThrow(redirectTo(staffHome(storeASlug)));
    expect(await catalogSnapshot(storeAId)).toEqual(before);
  });

  async function raceOwnerStaff(name: string) {
    asStore(storeASlug, cookies.ownerA);
    const preview = await csvPreviewAction(formWith(countedFile(name)));
    expect(preview.error).toBeUndefined();
    const token = preview.preview!.importToken;
    const selection = selectionOf(preview.preview!);
    const ownerHeaders = headersFor(storeASlug, cookies.ownerA);
    const staffHeaders = headersFor(storeASlug, cookies.staff);
    expect(await inStore(ownerHeaders, sessionUserId)).toBe(ids.ownerA);
    expect(await inStore(staffHeaders, sessionUserId)).toBe(ids.staff);
    const [ownerOutcome, staffOutcome] = await Promise.allSettled([
      inStore(ownerHeaders, () => csvCommitAction(token, selection)),
      inStore(staffHeaders, () => csvCommitAction(token, selection)),
    ]);
    return { token, ownerOutcome, staffOutcome };
  }

  function expectOwnerWon(outcome: PromiseSettledResult<Awaited<ReturnType<typeof csvCommitAction>>>) {
    expect(outcome.status).toBe("fulfilled");
    if (outcome.status !== "fulfilled") return;
    expect(outcome.value.error).toBeUndefined();
    expect(outcome.value.result?.createdCount).toBe(1);
    expect(outcome.value.result?.listingIds).toHaveLength(1);
    return outcome.value.result!.listingIds[0]!;
  }

  it("staff and owner commit the same token concurrently", async () => {
    const name = `Race ${RUN}`;
    const { token, ownerOutcome, staffOutcome } = await raceOwnerStaff(name);
    expectOwnerWon(ownerOutcome);
    expect(staffOutcome.status).toBe("rejected");
    if (staffOutcome.status === "rejected") expect(staffOutcome.reason).toEqual(redirectTo(staffHome(storeASlug)));
    const listings = await storeScoped(storeAId).listing.findMany({ where: { customName: name } });
    expect(listings).toHaveLength(1);
    const audits = await storeScoped(storeAId).auditLog.findMany({ where: { action: "catalog.csv_import" } });
    expect(audits.filter((row) => importIdOf(row.after) === token)).toHaveLength(1);
  });

  it("concurrent owner and staff commit attributes every effect to the owner", async () => {
    const name = `Race actor ${RUN}`;
    const { token, ownerOutcome, staffOutcome } = await raceOwnerStaff(name);
    const listingId = expectOwnerWon(ownerOutcome);
    expect(staffOutcome.status).toBe("rejected");
    if (staffOutcome.status === "rejected") expect(staffOutcome.reason).toEqual(redirectTo(staffHome(storeASlug)));
    const imported = await storeScoped(storeAId).listingImport.findUnique({ where: { id: token } });
    expect(imported?.createdById).toBe(ids.ownerA);
    expect(imported?.status).toBe("committed");
    const listing = await storeScoped(storeAId).listing.findFirst({
      where: { customName: name },
      include: { stockEvents: true },
    });
    expect(listing?.id).toBe(listingId);
    expect(listing?.stockEvents).toHaveLength(1);
    expect(listing?.stockEvents[0]?.actorId).toBe(ids.ownerA);
    const audits = await storeScoped(storeAId).auditLog.findMany({ where: { action: "catalog.csv_import", entityId: listingId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorId).toBe(ids.ownerA);
    expect(audits[0]?.actorEmail).toBe(emails.ownerA);
    const after = audits[0]?.after as { importId?: string; listingIds?: string[] };
    expect(after.importId).toBe(token);
    expect(after.listingIds).toEqual([listingId]);
  });

  it("owner of A in store B: both redirect to sign-in for B, B unchanged", async () => {
    const beforeB = await catalogSnapshot(storeBId);
    await expectDenied({
      slug: storeBSlug,
      cookie: cookies.ownerA,
      url: signIn(storeBSlug),
      csvName: `Cross action ${RUN}`,
      actorId: ids.ownerA,
      watchStoreIds: [storeAId, storeBId],
    });
    expect(await catalogSnapshot(storeBId)).toEqual(beforeB);
  });

  it("control creates all six isolation fixtures before probing B", async () => {
    const name = `Six control ${RUN}`;
    const imported = await importCounted(storeASlug, cookies.ownerA, name);
    const fixture = await loadSix(storeAId, ids.ownerA, emails.ownerA, name, imported.token);
    const before = await catalogSnapshot(storeAId);
    await expectHidden(storeBId, fixture);
    expect(await catalogSnapshot(storeAId)).toEqual(before);
  });

  it("storeScoped(B) cannot read, update or delete A's import rows or membership", async () => {
    const name = `Six probe ${RUN}`;
    const imported = await importCounted(storeASlug, cookies.ownerA, name);
    const fixture = await loadSix(storeAId, ids.ownerA, emails.ownerA, name, imported.token);
    const before = await catalogSnapshot(storeAId);
    await expectHidden(storeBId, fixture);
    expect(await catalogSnapshot(storeAId)).toEqual(before);
  });

  it("storeScoped(B) cannot create a membership in A", async () => {
    await expect(storeScoped(storeBId).storeMembership.create({
      data: { storeId: storeAId, userId: ids.intruder, role: "staff" },
    })).rejects.toThrow(/42501|row-level security/i);
    expect(await storeScoped(storeAId).storeMembership.findUnique({
      where: { storeId_userId: { storeId: storeAId, userId: ids.intruder } },
    })).toBeNull();
    expect(await platformAdmin.storeMembership.count({
      where: { storeId: storeAId, userId: ids.intruder },
    })).toBe(0);
  });

  it("authorized B owner cannot consume A token or change either store", async () => {
    const name = `Foreign ${RUN}`;
    asStore(storeASlug, cookies.ownerA);
    const preview = await csvPreviewAction(formWith(countedFile(name)));
    expect(preview.error).toBeUndefined();
    const token = preview.preview!.importToken;
    const beforeToken = await tokenView(storeAId, token);
    const beforeA = await catalogSnapshot(storeAId);
    const beforeB = await catalogSnapshot(storeBId);
    asStore(storeBSlug, cookies.ownerB);
    const stolen = await csvCommitAction(token, selectionOf(preview.preview!));
    expect(stolen.error).toBe("Import token is invalid, expired, or already used.");
    expect(stolen.result).toBeUndefined();
    expect(await tokenView(storeAId, token)).toEqual(beforeToken);
    expect(await catalogSnapshot(storeAId)).toEqual(beforeA);
    expect(await catalogSnapshot(storeBId)).toEqual(beforeB);
  });

  it("membership deleted between preview and commit: commit redirects", async () => {
    const name = `Removed ${RUN}`;
    asStore(storeDSlug, cookies.ownerD);
    const preview = await csvPreviewAction(formWith(countedFile(name)));
    expect(preview.error).toBeUndefined();
    const token = preview.preview!.importToken;
    const beforeToken = await tokenView(storeDId, token);
    await platformAdmin.storeMembership.delete({
      where: { storeId_userId: { storeId: storeDId, userId: ids.ownerD } },
    });
    const session = await readSession(cookies.ownerD);
    expect(session?.user.id).toBe(ids.ownerD);
    expect(await storeScoped(storeDId).storeMembership.findUnique({
      where: { storeId_userId: { storeId: storeDId, userId: ids.ownerD } },
    })).toBeNull();
    const before = await catalogSnapshot(storeDId);
    await expect(csvCommitAction(token, selectionOf(preview.preview!))).rejects.toThrow(redirectTo(signIn(storeDSlug)));
    expect(await catalogSnapshot(storeDId)).toEqual(before);
    expect(await tokenView(storeDId, token)).toEqual(beforeToken);
    expect(await storeScoped(storeDId).listing.findFirst({ where: { customName: name } })).toBeNull();
  });

  it("demoted owner is staff on the next preview and commit", async () => {
    const name = `Demote ${RUN}`;
    asStore(storeASlug, cookies.demote);
    const preview = await csvPreviewAction(formWith(countedFile(name)));
    expect(preview.error).toBeUndefined();
    const token = preview.preview!.importToken;
    const beforeToken = await tokenView(storeAId, token);
    await platformAdmin.storeMembership.update({
      where: { storeId_userId: { storeId: storeAId, userId: ids.demote } },
      data: { role: "staff" },
    });
    expect((await storeScoped(storeAId).storeMembership.findUnique({
      where: { storeId_userId: { storeId: storeAId, userId: ids.demote } },
    }))?.role).toBe("staff");
    const before = await catalogSnapshot(storeAId);
    asStore(storeASlug, cookies.demote);
    await expect(csvPreviewAction(formWith(countedFile(`${name} again`)))).rejects.toThrow(redirectTo(staffHome(storeASlug)));
    await expect(csvCommitAction(token, selectionOf(preview.preview!))).rejects.toThrow(redirectTo(staffHome(storeASlug)));
    expect(await catalogSnapshot(storeAId)).toEqual(before);
    expect(await tokenView(storeAId, token)).toEqual(beforeToken);
    expect(await storeScoped(storeAId).listing.findFirst({ where: { customName: name } })).toBeNull();
  });

  it("owner in A and staff in B uses the resolved store role", async () => {
    const name = `Mixed ${RUN}`;
    const imported = await importCounted(storeASlug, cookies.mixed, name);
    expect(imported.listingId).toBeTruthy();
    const beforeA = await catalogSnapshot(storeAId);
    const beforeB = await catalogSnapshot(storeBId);
    asStore(storeBSlug, cookies.mixed);
    await expect(csvPreviewAction(formWith(countedFile(`${name} B`)))).rejects.toThrow(redirectTo(staffHome(storeBSlug)));
    await expect(csvCommitAction(imported.token, selectionOf(imported.preview))).rejects.toThrow(redirectTo(staffHome(storeBSlug)));
    expect(await catalogSnapshot(storeAId)).toEqual(beforeA);
    expect(await catalogSnapshot(storeBId)).toEqual(beforeB);
    expect(await storeScoped(storeBId).listing.findFirst({ where: { customName: name } })).toBeNull();
  });

  it("verified platform admin without store membership cannot import", async () => {
    const session = await readSession(cookies.admin);
    expect(session?.user.id).toBe(ids.admin);
    expect(session?.user.twoFactorEnabled).toBe(true);
    expect(session?.session.twoFactorVerified).toBe(true);
    expect(session?.user.role).toBe("platform_admin");
    expect(await platformAdmin.storeMembership.count({ where: { userId: ids.admin } })).toBe(0);
    await expectDenied({
      slug: storeASlug,
      cookie: cookies.admin,
      url: signIn(storeASlug),
      csvName: `Platform admin ${RUN}`,
      actorId: ids.admin,
      actorStartsAtZero: true,
      watchStoreIds: [storeAId],
    });
  });

  it("revoked expired and tampered owner cookies cannot import", async () => {
    async function warm(cookie: string, name: string) {
      asStore(storeESlug, cookie);
      const preview = await csvPreviewAction(formWith(countedFile(name)));
      expect(preview.error).toBeUndefined();
      return { token: preview.preview!.importToken, selection: selectionOf(preview.preview!) };
    }
    async function denyStale(cookie: string, token: string, selection: CommitSelection, name: string) {
      expect(await readSession(cookie)).toBeNull();
      const before = await catalogSnapshot(storeEId);
      asStore(storeESlug, cookie);
      await expect(csvPreviewAction(formWith(countedFile(`${name} x`)))).rejects.toThrow(redirectTo(signIn(storeESlug)));
      await expect(csvCommitAction(token, selection)).rejects.toThrow(redirectTo(signIn(storeESlug)));
      expect(await catalogSnapshot(storeEId)).toEqual(before);
      expect((await tokenView(storeEId, token))?.status).toBe("pending");
    }

    const live = cookies.revoke;
    const revoked = await warm(live, `Revoke ${RUN}`);
    const signedOut = await authPost("/sign-out", {}, live);
    expect(signedOut.status).toBeLessThan(400);
    await denyStale(live, revoked.token, revoked.selection, `Revoke ${RUN}`);

    const expiredJar = await signInVerified(emails.revoke, secrets.revoke!);
    const expired = await warm(expiredJar.header(), `Expire ${RUN}`);
    const latest = await authPrisma.session.findFirst({ where: { userId: ids.revoke }, orderBy: { createdAt: "desc" } });
    expect(latest).toBeTruthy();
    await authPrisma.session.update({ where: { id: latest!.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await denyStale(expiredJar.header(), expired.token, expired.selection, `Expire ${RUN}`);

    const tamperJar = await signInVerified(emails.revoke, secrets.revoke!);
    const tampered = await warm(tamperJar.header(), `Tamper ${RUN}`);
    const bad = tamperJar.tamperSession();
    expect(bad.header()).not.toBe(tamperJar.header());
    await denyStale(bad.header(), tampered.token, tampered.selection, `Tamper ${RUN}`);

    expect((await storeScoped(storeEId).storeMembership.findUnique({
      where: { storeId_userId: { storeId: storeEId, userId: ids.revoke } },
    }))?.role).toBe("owner");
  }, 120_000);

  it("same verified session observes twoFactorEnabled becoming false", async () => {
    const name = `Flag ${RUN}`;
    asStore(storeASlug, cookies.flag);
    const preview = await csvPreviewAction(formWith(countedFile(name)));
    expect(preview.error).toBeUndefined();
    const token = preview.preview!.importToken;
    await authPrisma.user.update({ where: { id: ids.flag }, data: { twoFactorEnabled: false } });
    const session = await readSession(cookies.flag);
    expect(session?.user.id).toBe(ids.flag);
    expect(session?.session.twoFactorVerified).toBe(true);
    expect(session?.user.twoFactorEnabled).toBe(false);
    const before = await catalogSnapshot(storeAId);
    const beforeToken = await tokenView(storeAId, token);
    await expect(csvPreviewAction(formWith(countedFile(`${name} again`)))).rejects.toThrow(redirectTo(signIn(storeASlug)));
    await expect(csvCommitAction(token, selectionOf(preview.preview!))).rejects.toThrow(redirectTo(signIn(storeASlug)));
    expect(await catalogSnapshot(storeAId)).toEqual(before);
    expect(await tokenView(storeAId, token)).toEqual(beforeToken);
  });

  it("denied inputs never reach file or token validation", async () => {
    const expired = await platformAdmin.listingImport.create({
      data: {
        storeId: storeAId,
        csvText: `name,price,qty\nExpired ${RUN},1.00,1\n`,
        rowCount: 1,
        status: "pending",
        createdById: ids.ownerA,
        createdAt: new Date(Date.now() - 31 * 60 * 1000),
      },
    });
    const callers = [
      { cookie: cookies.staff, url: staffHome(storeASlug) },
      { cookie: "", url: signIn(storeASlug) },
    ];
    for (const caller of callers) {
      asStore(storeASlug, caller.cookie);
      const before = await catalogSnapshot(storeAId);
      await expect(csvPreviewAction(formWith())).rejects.toThrow(redirectTo(caller.url));
      await expect(csvPreviewAction(formWith("not-a-file"))).rejects.toThrow(redirectTo(caller.url));
      await expect(csvCommitAction("", EMPTY_SELECTION)).rejects.toThrow(redirectTo(caller.url));
      await expect(csvCommitAction("missing-token", EMPTY_SELECTION)).rejects.toThrow(redirectTo(caller.url));
      await expect(csvCommitAction(expired.id, EMPTY_SELECTION)).rejects.toThrow(redirectTo(caller.url));
      await expect(csvCommitAction(sharedToken, { matchedRows: "bad" } as unknown as CommitSelection)).rejects.toThrow(redirectTo(caller.url));
      expect(await catalogSnapshot(storeAId)).toEqual(before);
    }
    expect(await tokenView(storeAId, expired.id)).toMatchObject({ id: expired.id, status: "pending" });
  });

  it("denied preview preserves expired pending imports", async () => {
    const sentinel = await platformAdmin.listingImport.create({
      data: {
        storeId: storeAId,
        csvText: `name,price,qty\nSentinel ${RUN},1.00,1\n`,
        rowCount: 1,
        status: "pending",
        createdById: ids.ownerA,
        createdAt: new Date(Date.now() - 31 * 60 * 1000),
      },
    });
    const beforeToken = await tokenView(storeAId, sentinel.id);
    const before = await catalogSnapshot(storeAId);
    asStore(storeASlug, cookies.staff);
    await expect(csvPreviewAction(formWith(countedFile(`Sentinel deny ${RUN}`)))).rejects.toThrow(redirectTo(staffHome(storeASlug)));
    expect(await tokenView(storeAId, sentinel.id)).toEqual(beforeToken);
    expect(await catalogSnapshot(storeAId)).toEqual(before);
  });

  it("unknown or missing store slug: both actions not found, nothing written", async () => {
    const before = await Promise.all([catalogSnapshot(storeAId), catalogSnapshot(storeBId)]);
    asStore(missingSlug, cookies.ownerA);
    await expect(csvPreviewAction(formWith(countedFile(`Missing ${RUN}`)))).rejects.toThrow(notFoundError);
    await expect(csvCommitAction(sharedToken, sharedSelection())).rejects.toThrow(notFoundError);
    headerState.delete("x-store-slug");
    headerState.set("cookie", cookies.ownerA);
    await expect(csvPreviewAction(formWith(countedFile(`Missing none ${RUN}`)))).rejects.toThrow(notFoundError);
    await expect(csvCommitAction(sharedToken, sharedSelection())).rejects.toThrow(notFoundError);
    expect(await Promise.all([catalogSnapshot(storeAId), catalogSnapshot(storeBId)])).toEqual(before);
    expect((await tokenView(storeAId, sharedToken))?.status).toBe("pending");
  });

  it("owner empty inputs: no file, 0 bytes, header only", async () => {
    asStore(storeASlug, cookies.ownerA);
    const cases: Array<[FormData, string]> = [
      [formWith(), "Please select a CSV file."],
      [formWith(new File([""], "empty.csv", { type: "text/csv" })), "Please select a CSV file."],
      [formWith(new File(["name,price\n"], "headers.csv", { type: "text/csv" })), "File is empty or contains only headers."],
    ];
    for (const [form, message] of cases) {
      const before = await catalogSnapshot(storeAId);
      const result = await csvPreviewAction(form);
      expect(result.error).toBe(message);
      expect(result.preview).toBeUndefined();
      expect(await catalogSnapshot(storeAId)).toEqual(before);
    }
  });

  it("owner size boundary: exactly 2 MB passes, one byte over is refused", async () => {
    const name = `Exact ${RUN}`;
    asStore(storeASlug, cookies.ownerA);
    const before = await catalogSnapshot(storeAId);
    const exact = sizedCsv(name, 2_097_152);
    expect(exact.size).toBe(2_097_152);
    const preview = await csvPreviewAction(formWith(exact));
    expect(preview.error).toBeUndefined();
    expect(preview.preview?.newItems.map((item) => item.csvName)).toEqual([name]);
    expect(preview.preview?.unknownColumns).toContain("notes");
    expect(preview.preview?.importToken).toBeTruthy();
    const over = await csvPreviewAction(formWith(sizedCsv(`${name} over`, 2_097_153)));
    expect(over.error).toBe("File exceeds the maximum size of 2 MB.");
    expect(over.preview).toBeUndefined();
    const after = await catalogSnapshot(storeAId);
    const beforeIds = new Set((before.imports as Array<{ id: string }>).map((row) => row.id));
    const added = (after.imports as Array<{ id: string }>).map((row) => row.id).filter((id) => !beforeIds.has(id));
    expect(added).toEqual([preview.preview!.importToken]);
    await platformAdmin.listingImport.delete({ where: { id: preview.preview!.importToken } });
  }, 30_000);

  it("concurrent A and B owners keep imports and actors isolated", async () => {
    const nameA = `Iso A ${RUN}`;
    const nameB = `Iso B ${RUN}`;
    const headersA = headersFor(storeASlug, cookies.ownerA);
    const headersB = headersFor(storeBSlug, cookies.ownerB);
    expect(await inStore(headersA, sessionUserId)).toBe(ids.ownerA);
    expect(await inStore(headersB, sessionUserId)).toBe(ids.ownerB);
    const [previewA, previewB] = await Promise.all([
      inStore(headersA, () => csvPreviewAction(formWith(countedFile(nameA)))),
      inStore(headersB, () => csvPreviewAction(formWith(countedFile(nameB)))),
    ]);
    expect(previewA.error).toBeUndefined();
    expect(previewB.error).toBeUndefined();
    expect(previewA.preview?.newItems.map((item) => item.csvName)).toEqual([nameA]);
    expect(previewB.preview?.newItems.map((item) => item.csvName)).toEqual([nameB]);
    const [commitA, commitB] = await Promise.all([
      inStore(headersA, () => csvCommitAction(previewA.preview!.importToken, selectionOf(previewA.preview!))),
      inStore(headersB, () => csvCommitAction(previewB.preview!.importToken, selectionOf(previewB.preview!))),
    ]);
    expect(commitA.error).toBeUndefined();
    expect(commitB.error).toBeUndefined();
    expect(commitA.result?.createdCount).toBe(1);
    expect(commitB.result?.createdCount).toBe(1);
    const listingA = await storeScoped(storeAId).listing.findFirst({ where: { customName: nameA }, include: { stockEvents: true } });
    const listingB = await storeScoped(storeBId).listing.findFirst({ where: { customName: nameB }, include: { stockEvents: true } });
    expect(listingA?.id).toBe(commitA.result?.listingIds[0]);
    expect(listingB?.id).toBe(commitB.result?.listingIds[0]);
    expect(listingA?.stockEvents[0]?.actorId).toBe(ids.ownerA);
    expect(listingB?.stockEvents[0]?.actorId).toBe(ids.ownerB);
    expect(await storeScoped(storeAId).listing.findFirst({ where: { customName: nameB } })).toBeNull();
    expect(await storeScoped(storeBId).listing.findFirst({ where: { customName: nameA } })).toBeNull();
    expect((await storeScoped(storeAId).listingImport.findUnique({ where: { id: previewA.preview!.importToken } }))?.createdById).toBe(ids.ownerA);
    expect((await storeScoped(storeBId).listingImport.findUnique({ where: { id: previewB.preview!.importToken } }))?.createdById).toBe(ids.ownerB);
    const auditA = await storeScoped(storeAId).auditLog.findFirst({ where: { action: "catalog.csv_import", entityId: listingA!.id } });
    const auditB = await storeScoped(storeBId).auditLog.findFirst({ where: { action: "catalog.csv_import", entityId: listingB!.id } });
    expect(auditA?.actorId).toBe(ids.ownerA);
    expect(auditA?.actorEmail).toBe(emails.ownerA);
    expect(auditB?.actorId).toBe(ids.ownerB);
    expect(auditB?.actorEmail).toBe(emails.ownerB);
  });

  it("pending tokens stay under the cap and are read by id", async () => {
    for (const storeId of [storeAId, storeBId, storeDId, storeEId]) {
      const count = await storeScoped(storeId).listingImport.count({ where: { status: "pending" } });
      expect(count).toBeLessThan(10);
    }
    const shared = await storeScoped(storeAId).listingImport.findUnique({ where: { id: sharedToken } });
    expect(shared?.status).toBe("pending");
    expect(shared?.id).toBe(sharedToken);
  });
});
