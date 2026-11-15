import { describe, expect, it } from "vitest";
import { acquisitionSource, directoryLink } from "./attribution";

describe("directoryLink", () => {
  it("tags a storefront link with ref=directory and keeps the host and port", () => {
    expect(directoryLink("https://mama-ngozi.example.com/")).toBe("https://mama-ngozi.example.com/?ref=directory");
    expect(directoryLink("http://mama-ngozi.localhost:4454/")).toBe("http://mama-ngozi.localhost:4454/?ref=directory");
  });
});

describe("acquisitionSource", () => {
  it("is directory only for the exact cookie value, null otherwise", () => {
    expect(acquisitionSource("directory")).toBe("directory");
    for (const value of [undefined, "", "Directory", "directory ", "other"]) {
      expect(acquisitionSource(value)).toBeNull();
    }
  });
});
