import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateTOTP } from "../../../e2e/totp";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

vi.mock("next/headers", () => ({
  headers: async () => headerState,
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
  revalidatePath: () => {},
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

import type { PrismaClient } from "@prisma/client";
import { authPrisma } from "../db";
import { resolveDirectUrl } from "../env";
import { authPost, collectCookies } from "../test-auth";
import { testPrismaClient } from "../test-prisma";
import { seedMasterCatalog } from "../../../prisma/seed-master-catalog";
import { getMasterProductEditor, saveMasterProduct } from "./master-catalog";

// #613: a re-seed of the master catalog keeps what a platform admin changed through the admin.
const RUN = `sk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const password = "GuardPass-123!";
const adminEmail = `${RUN}-admin@test.example`;

const HEADER = [
  "id", "english_name", "local_names", "search_synonyms", "category", "subcategory", "origin_countries", "product_type",
  "common_brands", "unit", "common_pack_sizes", "typical_weight_g", "storage", "perishable", "description", "image_url",
  "image_source_page", "image_license", "image_author", "sources", "confidence", "notes",
] as const;
type Column = (typeof HEADER)[number];

function csvRow(id: string, over: Partial<Record<Column, string>> = {}): Record<Column, string> {
  const base = Object.fromEntries(HEADER.map((column) => [column, ""])) as Record<Column, string>;
  return {
    ...base, id, english_name: `${RUN} ${id}`, category: "tubers", unit: "kg", storage: "ambient", perishable: "yes",
    description: "Seeded text", confidence: "high", ...over,
  };
}

function writeCsv(rows: Array<Record<Column, string>>): string {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const lines = [HEADER.join(","), ...rows.map((row) => HEADER.map((column) => quote(row[column])).join(","))];
  const file = path.join(mkdtempSync(path.join(tmpdir(), "t613-")), "catalog.csv");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

async function signInPlatformAdmin(): Promise<{ id: string; cookies: string }> {
  const signedUp = await authPost("/sign-up/email", { email: adminEmail, password, name: RUN });
  expect(signedUp.status, await signedUp.clone().text()).toBe(200);
  const id = (await authPrisma.user.findFirstOrThrow({ where: { email: adminEmail } })).id;
  await authPrisma.user.update({ where: { id }, data: { role: "platform_admin" } });
  const signedIn = await authPost("/sign-in/email", { email: adminEmail, password });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  const cookies = collectCookies(signedIn);
  const enabled = await authPost("/two-factor/enable", { password }, cookies);
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret");
  if (!secret) throw new Error("TOTP URI has no secret");
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
  expect(verified.status, await verified.clone().text()).toBe(200);
  return { id, cookies: collectCookies(verified) || cookies };
}

describe("master catalog seed keeps admin changes (lane DB)", () => {
  let seedClient: PrismaClient;
  let adminId = "";
  let adminCookies = "";
  const productIds: string[] = [];

  const asPlatformAdmin = <T,>(fn: (tx: PrismaClient) => Promise<T>) =>
    seedClient.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return fn(tx as unknown as PrismaClient);
    });
  const readProduct = (id: string) => asPlatformAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id }, include: { synonyms: true } }));

  async function seed(rows: Array<Record<Column, string>>, extra: Parameters<typeof seedMasterCatalog>[1] = {}): Promise<string[]> {
    for (const row of rows) if (!productIds.includes(row.id)) productIds.push(row.id);
    const lines: string[] = [];
    await seedMasterCatalog(seedClient, {
      csvPath: writeCsv(rows),
      execution: { kind: "harness", mode: "off" },
      log: (line) => lines.push(line),
      ...extra,
    });
    return lines;
  }

  /** The editor form as the admin page loads it, with the given fields changed. */
  async function editorForm(id: string, changes: Record<string, string>): Promise<FormData> {
    const editor = await getMasterProductEditor(id);
    if (!editor) throw new Error(`no editor for ${id}`);
    const { product } = editor;
    const form = new FormData();
    const values: Record<string, string> = {
      productId: id, version: product.version, name: product.name, categoryId: product.categoryId ?? "",
      subcategory: product.subcategory ?? "", description: product.description ?? "", unit: product.unit ?? "",
      weightG: product.weightG === null ? "" : String(product.weightG), storage: product.storage ?? "", status: product.status,
      ...changes,
    };
    for (const [key, value] of Object.entries(values)) form.set(key, value);
    if (product.frozen) form.set("frozen", "on");
    if (product.perishable) form.set("perishable", "on");
    return form;
  }

  beforeAll(async () => {
    seedClient = testPrismaClient(resolveDirectUrl());
    await seedClient.$connect();
    ({ id: adminId, cookies: adminCookies } = await signInPlatformAdmin());
  }, 90_000);

  beforeEach(() => {
    headerState.set("cookie", adminCookies);
  });

  afterAll(async () => {
    if (!seedClient) return;
    await asPlatformAdmin(async (tx) => {
      if (adminId) await tx.auditLog.deleteMany({ where: { actorId: adminId } });
      await tx.catalogDuplicatePair.deleteMany({ where: { OR: [{ productAId: { in: productIds } }, { productBId: { in: productIds } }] } });
      await tx.productSynonym.deleteMany({ where: { productId: { in: productIds } } });
      await tx.masterProduct.updateMany({ where: { id: { in: productIds } }, data: { mergedIntoId: null } });
      await tx.masterProduct.deleteMany({ where: { id: { in: productIds } } });
      if (adminId) {
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id = ${adminId}`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${adminId}`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id = ${adminId}`;
        await tx.$executeRaw`DELETE FROM users WHERE id = ${adminId}`;
      }
    });
    await seedClient.$disconnect();
  });

  it("an admin edit survives a re-seed; untouched fields, untouched products and new products still follow the CSV", async () => {
    const edited = `${RUN}-yam`;
    const untouched = `${RUN}-plantain`;
    await seed([csvRow(edited), csvRow(untouched)]);

    const saved = await saveMasterProduct({}, await editorForm(edited, { name: `${RUN} Yam (admin)`, description: "Admin text", categoryId: "cat_grains" }));
    expect(saved).toMatchObject({ ok: true, message: "Saved" });

    const added = `${RUN}-cassava`;
    const lines = await seed([
      csvRow(edited, { english_name: `${RUN} Yam v2`, description: "Seeded text v2", unit: "piece" }),
      csvRow(untouched, { english_name: `${RUN} Plantain v2`, description: "Seeded text v2" }),
      csvRow(added),
    ]);

    expect(await readProduct(edited)).toMatchObject({
      name: `${RUN} Yam (admin)`, description: "Admin text", categoryId: "cat_grains", unit: "piece", status: "active",
    });
    expect(await readProduct(untouched)).toMatchObject({ name: `${RUN} Plantain v2`, description: "Seeded text v2", categoryId: "cat_tubers" });
    expect(await readProduct(added)).toMatchObject({ name: `${RUN} ${added}`, status: "active" });
    expect(lines).toContain("Kept admin changes on 1 product (the fields, status and synonyms an admin changed)");
  });
});
