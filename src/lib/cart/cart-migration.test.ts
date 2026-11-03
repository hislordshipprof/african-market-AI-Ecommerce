import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const hasDb = !!process.env.DATABASE_URL;

type Col = { column_name: string; data_type: string; is_nullable: string };

describe.skipIf(!hasDb)("Cart migration schema", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await db.$connect();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  const columns = async (table: string) => {
    const rows = await db.$queryRaw<Col[]>`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table}`;
    return Object.fromEntries(
      rows.map((r) => [r.column_name, `${r.data_type}:${r.is_nullable}`]),
    );
  };

  it("carts has the expected columns", async () => {
    // Later migrations add columns (customer_id, payment_intent_id), so assert
    // the original cart columns are present rather than the exact set.
    expect(await columns("carts")).toMatchObject({
      id: "text:NO",
      store_id: "text:NO",
      user_id: "text:YES",
      source: "text:NO",
      created_at: "timestamp without time zone:NO",
      updated_at: "timestamp without time zone:NO",
    });
  });

  it("cart_lines has the expected columns", async () => {
    expect(await columns("cart_lines")).toMatchObject({
      id: "text:NO",
      store_id: "text:NO",
      cart_id: "text:NO",
      variant_id: "text:NO",
      qty: "integer:NO",
      swap_rule: "text:NO",
      substitute_variant_id: "text:YES",
      created_at: "timestamp without time zone:NO",
      updated_at: "timestamp without time zone:NO",
    });
  });

  it("has foreign keys with the expected delete rules", async () => {
    const rows = await db.$queryRaw<
      { constraint_name: string; delete_rule: string }[]
    >`
      SELECT rc.constraint_name, rc.delete_rule
      FROM information_schema.referential_constraints rc
      WHERE rc.constraint_name IN (
        'carts_store_id_fkey', 'cart_lines_cart_id_fkey',
        'cart_lines_variant_id_fkey', 'cart_lines_substitute_variant_id_fkey')`;
    expect(
      Object.fromEntries(rows.map((r) => [r.constraint_name, r.delete_rule])),
    ).toEqual({
      carts_store_id_fkey: "RESTRICT",
      cart_lines_cart_id_fkey: "CASCADE",
      cart_lines_variant_id_fkey: "RESTRICT",
      cart_lines_substitute_variant_id_fkey: "SET NULL",
    });
  });

  it("has the unique and lookup indexes", async () => {
    const rows = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ('carts', 'cart_lines')`;
    const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(defs.cart_lines_cart_id_variant_id_key).toMatch(
      /CREATE UNIQUE INDEX .* \(cart_id, variant_id\)/,
    );
    expect(defs.carts_store_id_idx).toMatch(/\(store_id\)/);
    expect(defs.carts_store_id_user_id_idx).toMatch(/\(store_id, user_id\)/);
    expect(defs.cart_lines_store_id_idx).toMatch(/\(store_id\)/);
    expect(defs.cart_lines_cart_id_idx).toMatch(/\(cart_id\)/);
    expect(defs.cart_lines_variant_id_idx).toMatch(/\(variant_id\)/);
  });

  it("forces row level security on both tables", async () => {
    const rows = await db.$queryRaw<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('carts', 'cart_lines')
        AND c.relkind = 'r'`;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.relrowsecurity).toBe(true);
      expect(r.relforcerowsecurity).toBe(true);
    }
  });

  it("has store-scoped and platform-admin policies for app_user", async () => {
    const rows = await db.$queryRaw<
      {
        tablename: string;
        policyname: string;
        cmd: string;
        roles: string;
        qual: string;
        with_check: string;
      }[]
    >`
      SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('carts', 'cart_lines')`;
    const byName = Object.fromEntries(rows.map((r) => [r.policyname, r]));
    expect(Object.keys(byName).sort()).toEqual([
      "cart_lines_isolation",
      "cart_lines_platform_admin",
      "carts_isolation",
      "carts_platform_admin",
    ]);
    for (const r of rows) {
      expect(r.cmd).toBe("ALL");
      expect(r.roles).toContain("app_user");
    }
    for (const name of ["carts_isolation", "cart_lines_isolation"]) {
      expect(byName[name].qual).toContain("app.store_id");
      expect(byName[name].with_check).toContain("app.store_id");
    }
    for (const name of ["carts_platform_admin", "cart_lines_platform_admin"]) {
      expect(byName[name].qual).toContain("app.is_platform_admin");
      expect(byName[name].with_check).toContain("app.is_platform_admin");
    }
  });
});
