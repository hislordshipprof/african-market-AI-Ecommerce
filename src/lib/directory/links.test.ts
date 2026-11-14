import { describe, expect, it } from "vitest";
import { storefrontUrl } from "./links";

describe("storefrontUrl", () => {
  it("links a store to its subdomain of the root domain over https", () => {
    expect(storefrontUrl("mama-ngozi", "example.com", "www.example.com")).toBe("https://mama-ngozi.example.com/");
  });

  it("keeps the port and uses http on a localhost root", () => {
    expect(storefrontUrl("mama-ngozi", "localhost", "localhost:3195")).toBe("http://mama-ngozi.localhost:3195/");
  });

  it("returns null for a slug the proxy would not route", () => {
    expect(storefrontUrl("www", "example.com", "example.com")).toBeNull();
  });
});
