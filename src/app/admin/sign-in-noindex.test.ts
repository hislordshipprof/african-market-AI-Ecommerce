import { describe, expect, it } from "vitest";
import { metadata as adminMetadata } from "./layout";
import { metadata as storeAdminSignInMetadata } from "../store-admin/sign-in/layout";

describe("admin sign-in pages are not indexed", () => {
  it("platform admin pages (sign-in, reset-password, enroll-2fa) and the store-admin sign-in say noindex", () => {
    for (const metadata of [adminMetadata, storeAdminSignInMetadata]) {
      expect(metadata.robots).toEqual({ index: false, follow: false });
    }
  });
});
