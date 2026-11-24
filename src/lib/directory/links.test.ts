import { describe, expect, it } from "vitest";
import { directoryLink } from "./attribution";
import { directoryOrigin, storefrontUrl, storeWebAddress } from "./links";

const ALIAS = "african-market-ai-ecommerce.vercel.app";
const onAlias = { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: ALIAS };

describe("storefrontUrl", () => {
  it("links a store to its subdomain of the root domain over https", () => {
    expect(storefrontUrl("mama-ngozi", "www.example.com", { PLATFORM_ROOT_DOMAIN: "example.com" })).toBe("https://mama-ngozi.example.com/");
  });

  it("keeps the port and uses http on a localhost root", () => {
    expect(storefrontUrl("mama-ngozi", "localhost:3195", { PLATFORM_ROOT_DOMAIN: "localhost" })).toBe("http://mama-ngozi.localhost:3195/");
  });

  it("returns null for a slug the proxy would not route", () => {
    expect(storefrontUrl("www", "example.com", { PLATFORM_ROOT_DOMAIN: "example.com" })).toBeNull();
    expect(storefrontUrl("www", ALIAS, onAlias)).toBeNull();
  });

  it("on the production alias, links to the store on that address by ?store=, and the directory ref still applies (#766)", () => {
    const href = storefrontUrl("mama-ngozi", ALIAS, onAlias);
    expect(href).toBe(`https://${ALIAS}/?store=mama-ngozi`);
    expect(directoryLink(href!)).toBe(`https://${ALIAS}/?store=mama-ngozi&ref=directory`);
  });

  it("once PLATFORM_ROOT_DOMAIN is set, links are subdomains again (#766)", () => {
    expect(storefrontUrl("mama-ngozi", "example.com", { ...onAlias, PLATFORM_ROOT_DOMAIN: "example.com" })).toBe("https://mama-ngozi.example.com/");
  });
});

describe("directoryOrigin", () => {
  it("is https on a real root domain and http with the server's port on localhost", () => {
    expect(directoryOrigin({ PLATFORM_ROOT_DOMAIN: "example.com", PORT: "3000" })).toBe("https://example.com");
    expect(directoryOrigin({ PLATFORM_ROOT_DOMAIN: "localhost", PORT: "4451" })).toBe("http://localhost:4451");
  });

  it("is the production alias until PLATFORM_ROOT_DOMAIN is set (#766)", () => {
    expect(directoryOrigin(onAlias)).toBe(`https://${ALIAS}`);
    expect(directoryOrigin({ ...onAlias, PLATFORM_ROOT_DOMAIN: "example.com" })).toBe("https://example.com");
  });
});

describe("storeWebAddress (#784)", () => {
  it("is the ?store= form on the production alias", () => {
    expect(storeWebAddress("mama-ngozi", ALIAS, onAlias)).toBe(`https://${ALIAS}/?store=mama-ngozi`);
  });

  it("is the store's subdomain once PLATFORM_ROOT_DOMAIN is set", () => {
    expect(storeWebAddress("mama-ngozi", "mama-ngozi.example.com", { PLATFORM_ROOT_DOMAIN: "example.com" })).toBe("https://mama-ngozi.example.com/");
  });

  it("with no root domain (local or a preview), is ?store= on the address the admin is open on", () => {
    expect(storeWebAddress("mama-ngozi", "localhost:3195", {})).toBe("http://localhost:3195/?store=mama-ngozi");
    expect(storeWebAddress("mama-ngozi", "app-git-x.vercel.app", { VERCEL_ENV: "preview" })).toBe("https://app-git-x.vercel.app/?store=mama-ngozi");
  });

  it("is null for a slug the proxy would not route", () => {
    expect(storeWebAddress("www", "localhost:3195", {})).toBeNull();
  });
});
