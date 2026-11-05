import { describe, expect, it } from "vitest";
import { affectedTablesInMigrateDiff } from "./migrate-diff-tables";

const ELEVEN = `
ALTER TABLE "accounts" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "categories" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "listings" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "master_products" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "product_synonyms" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "sessions" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "store_banners" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "store_collections" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "stores" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "two_factors" ADD COLUMN "unexpected" TEXT;
`;

const ELEVEN_NAMES = [
  "accounts",
  "audit_logs",
  "categories",
  "listings",
  "master_products",
  "product_synonyms",
  "sessions",
  "store_banners",
  "store_collections",
  "stores",
  "two_factors",
];

const ELEVEN_AND_ORDERS = `
ALTER TABLE "accounts" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "categories" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "listings" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "master_products" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "product_synonyms" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "sessions" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "store_banners" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "store_collections" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "stores" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "two_factors" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "orders" ADD COLUMN "unexpected" TEXT;
`;

describe("affected tables in a migrate diff", () => {
  it("counts an extra orders alter as a twelfth table", () => {
    expect(affectedTablesInMigrateDiff(ELEVEN_AND_ORDERS)).toEqual([
      "accounts",
      "audit_logs",
      "categories",
      "listings",
      "master_products",
      "orders",
      "product_synonyms",
      "sessions",
      "store_banners",
      "store_collections",
      "stores",
      "two_factors",
    ]);
  });

  it("ignores an alter that is only a comment", () => {
    const script = `-- ALTER TABLE "listing_imports" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "stores" ADD COLUMN "unexpected" TEXT;`;
    expect(affectedTablesInMigrateDiff(script)).toEqual(["stores"]);
  });

  it("counts the table behind a dropped or renamed index", () => {
    const script = `
DROP INDEX "product_synonyms_term_trgm_idx";
ALTER INDEX "store_banners_store_id_active_sort_idx" RENAME TO "store_banners_store_id_active_sort_order_idx";
`;
    const indexToTable = new Map([
      ["product_synonyms_term_trgm_idx", "product_synonyms"],
      ["store_banners_store_id_active_sort_idx", "store_banners"],
    ]);
    expect(affectedTablesInMigrateDiff(script, indexToTable)).toEqual([
      "product_synonyms",
      "store_banners",
    ]);
  });

  it("keeps an index the database cannot map, so the exact set fails", () => {
    expect(affectedTablesInMigrateDiff(`DROP INDEX "orders_unexpected_idx";`)).toEqual([
      "unresolved index: orders_unexpected_idx",
    ]);
  });

  it("counts the table a created index is on", () => {
    const script = `CREATE UNIQUE INDEX "orders_unexpected_idx" ON "public"."orders"("unexpected");`;
    expect(affectedTablesInMigrateDiff(script)).toEqual(["orders"]);
  });

  it("counts a created or dropped table", () => {
    const script = `
CREATE TABLE "orders" (
    "id" TEXT NOT NULL
);
DROP TABLE "carts";
`;
    expect(affectedTablesInMigrateDiff(script)).toEqual(["carts", "orders"]);
  });

  it("does not count a table that is only referenced", () => {
    const script = `ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;`;
    expect(affectedTablesInMigrateDiff(script)).toEqual(["accounts"]);
  });

  it("reads a schema-qualified alter as the bare table", () => {
    const script = `ALTER TABLE "public"."stores" ALTER COLUMN "delivery_radius_mi" SET DATA TYPE DECIMAL(65,30);`;
    expect(affectedTablesInMigrateDiff(script)).toEqual(["stores"]);
  });

  it("counts one table once when the script alters it twice", () => {
    const script = `
ALTER TABLE "stores" ALTER COLUMN "delivery_radius_mi" SET DATA TYPE DECIMAL(65,30);
ALTER TABLE "public"."stores" ALTER COLUMN "updated_at" DROP DEFAULT;
`;
    expect(affectedTablesInMigrateDiff(script)).toEqual(["stores"]);
  });

  it("omitting one expected table is not the eleven", () => {
    const script = ELEVEN_AND_ORDERS
      .replace('ALTER TABLE "orders" ADD COLUMN "unexpected" TEXT;\n', "")
      .replace('ALTER TABLE "two_factors" ADD COLUMN "unexpected" TEXT;\n', "");
    expect(affectedTablesInMigrateDiff(script)).toEqual([
      "accounts",
      "audit_logs",
      "categories",
      "listings",
      "master_products",
      "product_synonyms",
      "sessions",
      "store_banners",
      "store_collections",
      "stores",
    ]);
  });

  it("maps a schema-qualified dropped index by its bare name", () => {
    const script = `DROP INDEX "public"."product_synonyms_term_trgm_idx";`;
    const indexToTable = new Map([["product_synonyms_term_trgm_idx", "product_synonyms"]]);
    expect(affectedTablesInMigrateDiff(script, indexToTable)).toEqual(["product_synonyms"]);
  });

  it("keeps an unmapped index whose quoted name is a keyword", () => {
    expect(affectedTablesInMigrateDiff(`${ELEVEN}\nDROP INDEX "ALTER";`)).toEqual([
      ...ELEVEN_NAMES,
      "unresolved index: ALTER",
    ]);
  });

  it("counts the table of a mapped index whose quoted name is a keyword", () => {
    expect(
      affectedTablesInMigrateDiff(`${ELEVEN}\nDROP INDEX "ALTER";`, new Map([["ALTER", "orders"]])),
    ).toEqual([
      "accounts",
      "audit_logs",
      "categories",
      "listings",
      "master_products",
      "orders",
      "product_synonyms",
      "sessions",
      "store_banners",
      "store_collections",
      "stores",
      "two_factors",
    ]);
  });

  it("counts the table under a created index whose quoted name is a keyword", () => {
    expect(
      affectedTablesInMigrateDiff(`${ELEVEN}\nCREATE INDEX "ALTER" ON "orders"("status");`),
    ).toEqual([
      "accounts",
      "audit_logs",
      "categories",
      "listings",
      "master_products",
      "orders",
      "product_synonyms",
      "sessions",
      "store_banners",
      "store_collections",
      "stores",
      "two_factors",
    ]);
  });

  it("counts the table of a renamed index whose quoted name is a keyword", () => {
    expect(
      affectedTablesInMigrateDiff(`ALTER INDEX "ALTER" RENAME TO "DROP";`, new Map([["ALTER", "orders"]])),
    ).toEqual(["orders"]);
  });

  it("keeps a schema-qualified quoted keyword index the database cannot map", () => {
    expect(affectedTablesInMigrateDiff(`DROP INDEX "public"."ON";`)).toEqual(["unresolved index: ON"]);
  });

  it("counts a quoted keyword table under a quoted keyword index name", () => {
    expect(affectedTablesInMigrateDiff(`CREATE INDEX "UNIQUE" ON "TABLE"("status");`)).toEqual(["TABLE"]);
  });

  it("counts a quoted keyword table name", () => {
    expect(affectedTablesInMigrateDiff(`ALTER TABLE "ON" ADD COLUMN "unexpected" TEXT;`)).toEqual(["ON"]);
  });

  it("counts created and dropped tables whose names are keywords", () => {
    const script = `
CREATE TABLE "INDEX" ("id" TEXT NOT NULL);
DROP TABLE "DROP";
`;
    expect(affectedTablesInMigrateDiff(script)).toEqual(["DROP", "INDEX"]);
  });

  it("reads a quoted keyword index after the create-index preamble", () => {
    const script = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ALTER" ON ONLY "orders"("status");`;
    expect(affectedTablesInMigrateDiff(script)).toEqual(["orders"]);
  });

  it("preserves the case of a quoted index name", () => {
    expect(affectedTablesInMigrateDiff(`DROP INDEX "alter";`)).toEqual(["unresolved index: alter"]);
  });

  it("still treats an unquoted ON as syntax", () => {
    expect(affectedTablesInMigrateDiff(`CREATE INDEX orders_status_idx ON orders(status);`)).toEqual(["orders"]);
  });

  it("does not count a quoted keyword that is only referenced", () => {
    const script = `ALTER TABLE "accounts" ADD CONSTRAINT "c" FOREIGN KEY ("user_id") REFERENCES "ON"("id");`;
    expect(affectedTablesInMigrateDiff(script)).toEqual(["accounts"]);
  });

  it("ignores a commented drop of a keyword index", () => {
    const script = `-- DROP INDEX "ALTER";
ALTER TABLE "stores" ADD COLUMN "unexpected" TEXT;`;
    expect(affectedTablesInMigrateDiff(script)).toEqual(["stores"]);
  });

  it("does not count a column whose name is a keyword", () => {
    expect(affectedTablesInMigrateDiff(`ALTER TABLE "stores" ADD COLUMN "ALTER" TEXT;`)).toEqual(["stores"]);
  });

  it("keeps a quote inside an unmapped index name", () => {
    expect(affectedTablesInMigrateDiff(`DROP INDEX "AL""TER";`)).toEqual(['unresolved index: AL"TER']);
  });
});
