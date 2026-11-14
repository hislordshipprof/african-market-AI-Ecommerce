import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  FakeVercelDomainsAdapter,
  RealVercelDomainsAdapter,
  VercelApiError,
  createVercelDomainsAdapter,
} from "./vercel-domains";

// Vercel's project-domain response shape (v10), trimmed to the fields Vercel always sends.
function domainBody(name: string, verified: boolean) {
  return {
    name,
    apexName: name.split(".").slice(-2).join("."),
    projectId: "prj_test",
    verified,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RealVercelDomainsAdapter (fake HTTP)", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let adapter: RealVercelDomainsAdapter;

  beforeEach(() => {
    vi.stubEnv("VERCEL_TOKEN", "tok");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_test");
    vi.stubEnv("VERCEL_TEAM_ID", "team_1");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    adapter = new RealVercelDomainsAdapter();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("addDomain posts to the project and returns the CNAME target and pending status", async () => {
    fetchMock.mockResolvedValueOnce(json(200, domainBody("shop.mamasmarket.com", false)));
    await expect(adapter.addDomain("shop.mamasmarket.com")).resolves.toEqual({
      domain: "shop.mamasmarket.com",
      verified: false,
      cname: "cname.vercel-dns.com",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.vercel.com/v10/projects/prj_test/domains?teamId=team_1");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "shop.mamasmarket.com" });
  });

  it("addDomain maps a 409 to domain_already_in_use", async () => {
    fetchMock.mockResolvedValueOnce(
      json(409, { error: { code: "domain_already_in_use", message: "in use" } }),
    );
    await expect(adapter.addDomain("shop.mamasmarket.com")).rejects.toMatchObject({
      status: 409,
      code: "domain_already_in_use",
    });
  });

  it("addDomain retries after a 429 and returns the later success", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json(429, { error: { code: "rate_limited" } }))
      .mockResolvedValueOnce(json(200, domainBody("shop.mamasmarket.com", true)));
    const result = adapter.addDomain("shop.mamasmarket.com");
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ verified: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("addDomain gives up with rate_limited after three 429s", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => json(429, { error: { code: "rate_limited" } }));
    const result = adapter.addDomain("shop.mamasmarket.com");
    const settled = expect(result).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    await vi.runAllTimersAsync();
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("getDomainConfig reads the verified flag and maps 404 to not_found", async () => {
    fetchMock.mockResolvedValueOnce(json(200, domainBody("shop.mamasmarket.com", true)));
    await expect(adapter.getDomainConfig("shop.mamasmarket.com")).resolves.toEqual({
      domain: "shop.mamasmarket.com",
      verified: true,
      cname: "cname.vercel-dns.com",
    });
    fetchMock.mockResolvedValueOnce(json(404, { error: { code: "not_found" } }));
    await expect(adapter.getDomainConfig("gone.example.com")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("removeDomain deletes on the project and maps 404 to not_found", async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));
    await expect(adapter.removeDomain("shop.mamasmarket.com")).resolves.toEqual({
      domain: "shop.mamasmarket.com",
      removed: true,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.vercel.com/v10/projects/prj_test/domains/shop.mamasmarket.com?teamId=team_1",
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
    fetchMock.mockResolvedValueOnce(json(404, { error: { code: "not_found" } }));
    await expect(adapter.removeDomain("gone.example.com")).rejects.toMatchObject({ status: 404 });
  });

  it("gives up on a hung Vercel call with a 504 instead of holding the admin request open", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const result = adapter.getDomainConfig("shop.mamasmarket.com");
    const settled = expect(result).rejects.toMatchObject({ status: 504, code: "timeout" });
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
  });

  it("surfaces any other Vercel error with its status", async () => {
    fetchMock.mockResolvedValueOnce(json(400, { error: { code: "invalid_domain" } }));
    await expect(adapter.addDomain("bad")).rejects.toMatchObject({ status: 400 });
  });
});

describe("createVercelDomainsAdapter", () => {
  const keys = { VERCEL_TOKEN: "t", VERCEL_PROJECT_ID: "p" };

  it("uses the fake in test and development when keys are missing", () => {
    expect(createVercelDomainsAdapter({ NODE_ENV: "test" })).toBeInstanceOf(FakeVercelDomainsAdapter);
    expect(createVercelDomainsAdapter({ NODE_ENV: "development" })).toBeInstanceOf(FakeVercelDomainsAdapter);
  });

  it("uses the real adapter whenever the keys are set", () => {
    expect(createVercelDomainsAdapter({ NODE_ENV: "development", ...keys })).toBeInstanceOf(RealVercelDomainsAdapter);
    expect(createVercelDomainsAdapter({ NODE_ENV: "production", VERCEL: "1", ...keys })).toBeInstanceOf(RealVercelDomainsAdapter);
  });

  it("throws in production when keys are missing instead of faking", () => {
    expect(() => createVercelDomainsAdapter({ NODE_ENV: "production" })).toThrow(/VERCEL_TOKEN/);
    expect(() => createVercelDomainsAdapter({ NODE_ENV: "production", VERCEL_TOKEN: "t" })).toThrow(/VERCEL_PROJECT_ID/);
  });

  it("throws on a Vercel deployment with missing keys even if NODE_ENV is not production", () => {
    expect(() => createVercelDomainsAdapter({ NODE_ENV: "development", VERCEL: "1" })).toThrow(/VERCEL_TOKEN/);
  });

  it("throws when only some keys are set in development rather than half-faking", () => {
    expect(() => createVercelDomainsAdapter({ NODE_ENV: "development", VERCEL_TOKEN: "t" })).toThrow(/VERCEL_PROJECT_ID/);
  });
});
