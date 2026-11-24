import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

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
