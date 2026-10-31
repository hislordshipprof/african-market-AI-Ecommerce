import { describe, it, expect } from "vitest";
import { slugFromHost, RESERVED_SLUGS } from "./slug";

describe("slugFromHost", () => {
  it("extracts slug from subdomain with root domain", () => {
    expect(slugFromHost("mama-ngozi.example.com", "example.com")).toBe(
      "mama-ngozi",
    );
  });

  it("strips port", () => {
    expect(slugFromHost("mama-ngozi.localhost:3000")).toBe("mama-ngozi");
  });

  it("lowercases", () => {
    expect(slugFromHost("Mama-Ngozi.localhost:3000")).toBe("mama-ngozi");
  });

  it("returns null for apex domain", () => {
    expect(slugFromHost("example.com", "example.com")).toBeNull();
  });

  it("returns null for www", () => {
    expect(slugFromHost("www.example.com", "example.com")).toBeNull();
  });

  it("returns null for *.vercel.app", () => {
    expect(slugFromHost("my-app-abc123.vercel.app")).toBeNull();
  });

  it("returns null for bare localhost", () => {
    expect(slugFromHost("localhost:3000")).toBeNull();
  });

  it("returns null for IP address first label", () => {
    expect(slugFromHost("192.168.1.1:3000")).toBeNull();
  });

  it("handles localhost subdomain with root domain", () => {
    expect(slugFromHost("mama-ngozi.localhost:3000", "localhost")).toBe(
      "mama-ngozi",
    );
  });

  it("handles port with root domain", () => {
    expect(slugFromHost("tante-marie.example.com:443", "example.com")).toBe(
      "tante-marie",
    );
  });

  it("returns null for production vercel.app deploy URLs", () => {
    expect(
      slugFromHost("african-markets-platform-git-main.vercel.app"),
    ).toBeNull();
  });

  for (const slug of RESERVED_SLUGS) {
    it(`returns null for reserved slug '${slug}' without root domain`, () => {
      expect(slugFromHost(`${slug}.example.com:3000`)).toBeNull();
    });

    it(`returns null for reserved slug '${slug}' with root domain`, () => {
      expect(slugFromHost(`${slug}.example.com`, "example.com")).toBeNull();
    });
  }
});

describe("RESERVED_SLUGS", () => {
  it("contains www, admin, api, app, mail, static, assets, cdn, vercel", () => {
    for (const slug of ["www", "admin", "api", "app", "mail", "static", "assets", "cdn", "vercel"]) {
      expect(RESERVED_SLUGS.has(slug)).toBe(true);
    }
  });
});
