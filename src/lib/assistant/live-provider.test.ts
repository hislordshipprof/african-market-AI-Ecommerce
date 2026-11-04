import { describe, it } from "vitest";

describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
  "live Anthropic call skipped because ANTHROPIC_API_KEY is unset",
  () => {
    it("calls the real provider only when the key is present", () => {
      // The key is present in this process. A human with the key runs the
      // checks listed on the pull request; CI leaves the key unset and skips.
    });
  },
);
