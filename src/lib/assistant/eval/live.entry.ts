import { describe, it } from "vitest";

describe("live shopper assistant eval", () => {
  it("runs the opted-in eval against the real model", async () => {
    const { runLiveEval } = await import("./live-run");
    await runLiveEval();
  });
});
