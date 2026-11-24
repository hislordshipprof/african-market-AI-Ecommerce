import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/get-store", () => ({ getStore: async () => ({ name: "Mama Ngozi Market" }) }));
vi.mock("@/components/storefront/storefront-shell", () => ({
  StorefrontShell: ({ children }: { children: unknown }) => children,
}));

import SignInPage from "./page";

async function markup(): Promise<string> {
  return renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({}) }));
}

function production(emailFrom: string) {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CI", "");
  vi.stubEnv("EMAIL_FROM", emailFrom);
}

describe("/account/sign-in without a sender address in production (#765)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("says email sign-in is not available yet, and offers no email field to send to", async () => {
    production("");
    const html = await markup();
    expect(html).toContain("Email sign-in is not available yet");
    expect(html).not.toContain('type="email"');
  });

  it("shows the email form once a real sender is set", async () => {
    production("Market <orders@markets.example>");
    const html = await markup();
    expect(html).not.toContain("Email sign-in is not available yet");
    expect(html).toContain('type="email"');
  });
});
