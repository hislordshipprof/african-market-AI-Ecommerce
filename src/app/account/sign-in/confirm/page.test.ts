import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/get-store", () => ({ getStore: async () => ({ name: "Mama Ngozi Market" }) }));
vi.mock("@/components/storefront/storefront-shell", () => ({
  StorefrontShell: ({ children }: { children: unknown }) => children,
}));

import ConfirmSignInPage from "./page";

async function callbackField(callbackURL: string): Promise<string | null> {
  const page = await ConfirmSignInPage({ searchParams: Promise.resolve({ token: "t", callbackURL }) });
  return renderToStaticMarkup(page).match(/name="callbackURL" value="([^"]*)"/)?.[1] ?? null;
}

describe("sign-in confirm page callbackURL", () => {
  it("keeps a same-site path", async () => {
    expect(await callbackField("/account/orders?tab=1")).toBe("/account/orders?tab=1");
  });

  it("replaces a backslash or encoded separator with /account", async () => {
    for (const value of ["/\\evil.com", "/%5Cevil.com", "/%2F%2Fevil.com", "//evil.com"]) {
      expect(await callbackField(value)).toBe("/account");
    }
  });
});
