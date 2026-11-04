import { describe, it } from "vitest";

const hasRuntime = !!process.env.DATABASE_URL && !!process.env.APP_RUNTIME_PASSWORD;

describe.skipIf(!hasRuntime)("catalog photo audit reader skips without a runtime password", () => {
  it("does not run when the runtime password is absent", () => {
    throw new Error("suite ran without APP_RUNTIME_PASSWORD");
  });
});
