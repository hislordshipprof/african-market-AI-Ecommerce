import { describe, expect, it } from "vitest";
import { catalogFiltersFromSearchParams } from "./master-catalog-form";

describe("catalogFiltersFromSearchParams", () => {
  it("reads every filter and the page from the list page's query string", () => {
    expect(catalogFiltersFromSearchParams({
      q: "egusi", category: "cat1", status: "archived", photo: "missing", attributes: "unreviewed", page: "3",
    })).toEqual({ q: "egusi", category: "cat1", status: "archived", photo: "missing", attributes: "unreviewed", page: 3 });
  });

  it("drops empty, unknown and repeated values instead of failing the page", () => {
    expect(catalogFiltersFromSearchParams({
      q: "", category: "", status: "deleted", photo: "yes", attributes: "all", page: "0",
    })).toEqual({});
    expect(catalogFiltersFromSearchParams({ status: ["active", "archived"], page: "-2" })).toEqual({});
  });

  it("drops a search over 200 characters rather than truncating it", () => {
    expect(catalogFiltersFromSearchParams({ q: "a".repeat(201) })).toEqual({});
    expect(catalogFiltersFromSearchParams({ q: `  ${"a".repeat(200)}  ` }).q).toHaveLength(204);
  });
});
