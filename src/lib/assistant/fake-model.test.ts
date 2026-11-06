import { describe, expect, it } from "vitest";
import { assistantFakeAllowed } from "./contract";

describe("assistant e2e fake", () => {
  it("the e2e fake is selected only with CI=true and no VERCEL, or outside production", () => {
    const env = (extra: Record<string, string | undefined>): NodeJS.ProcessEnv => ({ ...process.env, VERCEL: undefined, ...extra });
    expect(assistantFakeAllowed(env({ E2E_FAKE_ASSISTANT: "1", CI: "true" }))).toBe(true);
    expect(assistantFakeAllowed(env({ E2E_FAKE_ASSISTANT: "1", NODE_ENV: "development", CI: undefined }))).toBe(true);
    expect(assistantFakeAllowed(env({ E2E_FAKE_ASSISTANT: "1", CI: "true", VERCEL: "1" }))).toBe(false);
    expect(assistantFakeAllowed(env({ E2E_FAKE_ASSISTANT: "1", NODE_ENV: "production", CI: undefined }))).toBe(false);
    expect(assistantFakeAllowed(env({ E2E_FAKE_ASSISTANT: undefined, NODE_ENV: "development" }))).toBe(false);
  });
});
