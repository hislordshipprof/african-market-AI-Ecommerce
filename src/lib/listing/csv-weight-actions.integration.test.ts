import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

import { generateTOTP } from "../../../e2e/totp";

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

vi.mock("next/headers", () => ({
  headers: async () => headerState,
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { auth } from "../auth";
import { authPrisma, storeScoped } from "../db";
import { csvCommitAction, csvPreviewAction } from "./csv-import-actions";

const hasDb = !!process.env.DATABASE_URL;
const BASE = "http://localhost:3000/api/auth";
const RUN = `w215-act-${Date.now()}`;
const password = "WeightPass-123!";

async function authPost(path: string, body: unknown, cookies?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies) headers.cookie = cookies;
  return auth.handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

function collectCookies(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).join("; ");
}

async function signUp(email: string, name: string): Promise<void> {
  const res = await authPost("/sign-up/email", { email, password, name });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function ownerSession(email: string): Promise<string> {
  const signedIn = await authPost("/sign-in/email", { email, password });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  const cookies = collectCookies(signedIn);
  const enabled = await authPost("/two-factor/enable", { password }, cookies);
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  const body = await enabled.json();
  const secret = new URL(body.totpURI as string).searchParams.get("secret");
  if (!secret) throw new Error("TOTP URI has no secret");
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
  expect(verified.status, await verified.clone().text()).toBe(200);
  return collectCookies(verified) || cookies;
}

function asStore(slug: string, cookies: string) {
  headerState.set("cookie", cookies);
  headerState.set("x-store-slug", slug);
}

describe.skipIf(!hasDb)("csv weight actions (real auth, lane DB)", () => {
  const ownerAEmail = `weight-a-${RUN}@example.com`;
  const ownerBEmail = `weight-b-${RUN}@example.com`;
  const storeASlug = `weight-a-${RUN}`;
  const storeBSlug = `weight-b-${RUN}`;
  let storeAId = "";
  let storeBId = "";
  let ownerAId = "";
  let ownerBId = "";
  let cookiesA = "";
  let cookiesB = "";

  beforeAll(async () => {
    await signUp(ownerAEmail, "Weight Owner A");
    await signUp(ownerBEmail, "Weight Owner B");
    const ownerA = await authPrisma.user.findFirstOrThrow({ where: { email: ownerAEmail } });
    const ownerB = await authPrisma.user.findFirstOrThrow({ where: { email: ownerBEmail } });
    ownerAId = ownerA.id;
    ownerBId = ownerB.id;
    storeAId = crypto.randomUUID();
    storeBId = crypto.randomUUID();

    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeAId}, ${"Weight A " + RUN}, ${storeASlug}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeBId}, ${"Weight B " + RUN}, ${storeBSlug}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeAId}, ${ownerAId}, 'owner', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeBId}, ${ownerBId}, 'owner', now())`;
    });

    cookiesA = await ownerSession(ownerAEmail);
    cookiesB = await ownerSession(ownerBEmail);
  });

  afterAll(async () => {
    const emails = [ownerAEmail, ownerBEmail];
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM listing_variants WHERE listing_id IN (SELECT id FROM listings WHERE store_id IN (${storeAId}, ${storeBId}))`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM stock_events WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM listings WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM listing_imports WHERE store_id IN (${storeAId}, ${storeBId})`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE store_id IN (${storeAId}, ${storeBId})`;
      for (const email of emails) {
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx.$executeRaw`DELETE FROM verifications WHERE value LIKE ${"%" + email + "%"}`;
        await tx.$executeRaw`DELETE FROM users WHERE email = ${email}`;
      }
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${storeAId}, ${storeBId})`;
    });
  });

  it("an owner signed in through auth.handler imports a weight column and the variant stores 22680", async () => {
    const name = `E2E Garri ${RUN}`;
    asStore(storeASlug, cookiesA);
    const form = new FormData();
    form.set("file", new File([`name,price,weight\n${name},45.00,50 lb\n`], "garri.csv", { type: "text/csv" }));
    const preview = await csvPreviewAction(form);
    expect(preview.error).toBeUndefined();
    expect(preview.preview?.newItems.map((item) => item.csvName)).toEqual([name]);

    const selection = {
      matchedRows: [] as number[],
      newItemRows: [preview.preview!.newItems[0]!.row],
      ambiguousResolutions: [],
    };
    const committed = await csvCommitAction(preview.preview!.importToken, selection);
    expect(committed.error).toBeUndefined();
    expect(committed.result?.createdCount).toBe(1);

    const listing = await storeScoped(storeAId).listing.findFirst({
      where: { customName: name },
      include: { variants: true },
    });
    expect(listing?.price).toBe(4500);
    expect(listing?.variants).toHaveLength(1);
    expect(listing?.variants[0]?.weightG).toBe(22680);
    expect(listing?.variants[0]?.price).toBe(4500);

    const retried = await csvCommitAction(preview.preview!.importToken, selection);
    expect(retried.error).toBeUndefined();
    expect(retried.result).toEqual(committed.result);
    const rows = await storeScoped(storeAId).listing.findMany({
      where: { customName: name },
      include: { variants: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.variants[0]?.weightG).toBe(22680);
  });

  it("a store B owner cannot commit store A's import token", async () => {
    const name = `E2E Cross ${RUN}`;
    asStore(storeASlug, cookiesA);
    const form = new FormData();
    form.set("file", new File([`name,price,weight\n${name},12.00,1 kg\n`], "cross.csv", { type: "text/csv" }));
    const preview = await csvPreviewAction(form);
    expect(preview.error).toBeUndefined();
    const token = preview.preview!.importToken;

    asStore(storeBSlug, cookiesB);
    const stolen = await csvCommitAction(token, {
      matchedRows: [],
      newItemRows: [2],
      ambiguousResolutions: [],
    });
    expect(stolen.error).toBe("Import token is invalid, expired, or already used.");
    expect(stolen.result).toBeUndefined();

    asStore(storeASlug, cookiesA);
    const pending = await storeScoped(storeAId).listingImport.findUnique({ where: { id: token } });
    expect(pending?.status).toBe("pending");
    const listings = await storeScoped(storeAId).listing.findMany({ where: { customName: name } });
    expect(listings).toEqual([]);
  });
});
