import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => search.params }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
const store = vi.hoisted(() => ({ slug: null as string | null }));
vi.mock("@/lib/get-store", () => ({ findStoreForHeaders: async () => (store.slug ? { slug: store.slug } : null) }));

import ResetPasswordPage from "./page";

function production(emailFrom: string) {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CI", "");
  vi.stubEnv("EMAIL_FROM", emailFrom);
}

describe("staff password reset without a sender address in production (#765)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("says a reset by email is not available yet instead of offering to send a link", async () => {
    production("");
    const html = renderToStaticMarkup(await ResetPasswordPage());
    expect(html).toContain("Email sign-in is not available yet");
    expect(html).not.toContain('id="reset-email"');
  });

  it("offers to send the link once a real sender is set", async () => {
    production("Market <orders@markets.example>");
    const html = renderToStaticMarkup(await ResetPasswordPage());
    expect(html).not.toContain("Email sign-in is not available yet");
    expect(html).toContain('id="reset-email"');
  });
});

describe("password reset started from store admin (#797)", () => {
  afterEach(() => {
    search.params = new URLSearchParams();
    store.slug = null;
  });

  it("leads back to that store's sign-in", async () => {
    search.params = new URLSearchParams("from=store-admin");
    store.slug = "mama-ngozi";
    const html = renderToStaticMarkup(await ResetPasswordPage());
    expect(html).toContain('href="/store-admin/sign-in?store=mama-ngozi"');
  });

  it("a platform admin's reset leads to the platform sign-in, whatever store is remembered", async () => {
    store.slug = "mama-ngozi";
    const html = renderToStaticMarkup(await ResetPasswordPage());
    expect(html).toContain('href="/admin/sign-in"');
  });
});
