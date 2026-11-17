import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function ignored(file: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", file], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe(".gitignore", () => {
  it("keeps environment files, Vercel project state and private keys out of git", () => {
    const files = [
      ".env.production",
      ".env.development",
      ".env.staging",
      ".vercel/project.json",
      "certs/server.pem",
      "certs/server.key",
    ];
    expect(files.filter((file) => !ignored(file))).toEqual([]);
  });
});
