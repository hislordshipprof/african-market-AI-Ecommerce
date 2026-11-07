import { describe, expect, it } from "vitest";
import { assistantAccountId } from "./account-id";

describe("assistant account id", () => {
  it("keeps the guest launcher when the session read cannot start a transaction", async () => {
    await expect(assistantAccountId(async () => {
      throw Object.assign(new Error("Unable to start a transaction in the given time."), { code: "P2028" });
    })).resolves.toBeNull();
    await expect(assistantAccountId(async () => null)).resolves.toBeNull();
    await expect(assistantAccountId(async () => ({ user: { id: "" } }))).resolves.toBeNull();
    await expect(assistantAccountId(async () => ({ user: { id: "user-1" } }))).resolves.toBe("user-1");
  });
});
