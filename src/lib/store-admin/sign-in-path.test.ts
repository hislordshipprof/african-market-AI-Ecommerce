import { describe, expect, it } from "vitest";
import { storeAdminReturnPath, storeSignInPath, storeTwoFactorPath } from "./sign-in-path";

describe("storeSignInPath (#797)", () => {
  it("names the store and the page the member asked for", () => {
    expect(storeSignInPath("mama-ngozi", "/store-admin/orders?order=o1")).toBe(
      "/store-admin/sign-in?store=mama-ngozi&next=%2Fstore-admin%2Forders%3Forder%3Do1",
    );
  });

  it("leaves out a page that is not a store admin page, or the dashboard itself", () => {
    for (const path of [null, "/store-admin", "/cart", "/store-admin/sign-in?store=x"]) {
      expect(storeSignInPath("mama-ngozi", path)).toBe("/store-admin/sign-in?store=mama-ngozi");
    }
  });
});

describe("storeAdminReturnPath (#797)", () => {
  it("returns to the page the member asked for", () => {
    expect(storeAdminReturnPath("/store-admin/orders?order=o1", "mama-ngozi")).toBe("/store-admin/orders?order=o1");
  });

  it("goes to the store's dashboard otherwise", () => {
    expect(storeAdminReturnPath(null, "mama-ngozi")).toBe("/store-admin?store=mama-ngozi");
    expect(storeAdminReturnPath(null, null)).toBe("/store-admin");
  });

  it("never leaves store admin or the site", () => {
    for (const next of ["https://evil.example/store-admin", "//evil.example/store-admin", "/\\evil.example", "/store-adminx", "/admin", "/store-admin/sign-in", "/store-admin/two-factor?next=%2Fstore-admin"]) {
      expect(storeAdminReturnPath(next, "mama-ngozi")).toBe("/store-admin?store=mama-ngozi");
    }
  });
});

describe("storeTwoFactorPath (#840)", () => {
  it("names the store and the page to come back to", () => {
    expect(storeTwoFactorPath("mama-ngozi", "/store-admin/team?store=mama-ngozi")).toBe(
      "/store-admin/two-factor?store=mama-ngozi&next=%2Fstore-admin%2Fteam%3Fstore%3Dmama-ngozi",
    );
  });
});
