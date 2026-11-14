import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockHandler = vi.fn((_req: Request) =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }),
);

const mockRegisteredCustomDomain = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: { handler: mockHandler },
  registeredCustomDomain: (headers: Headers) => mockRegisteredCustomDomain(headers),
  onCustomDomain: (url: string) => url,
}));

vi.mock("better-auth/next-js", () => ({
  toNextJsHandler: () => ({
    GET: (req: Request) => mockHandler(req),
    POST: (req: Request) => mockHandler(req),
  }),
}));

const { GET, POST } = await import("./[...all]/route");

beforeEach(() => {
  mockHandler.mockClear();
  mockRegisteredCustomDomain.mockReset().mockResolvedValue(null);
});

describe("E5: callbackURL validation", () => {
  it("GET rejects absolute callbackURL in query", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/auth/magic-link/verify?token=abc&callbackURL=https://evil.com",
      { headers: { "x-store-slug": "test-store" } },
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("callbackURL");
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("GET rejects protocol-relative callbackURL", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/auth/magic-link/verify?token=abc&callbackURL=//evil.com/path",
      { headers: { "x-store-slug": "test-store" } },
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("GET allows relative callbackURL", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/auth/magic-link/verify?token=abc&callbackURL=/account",
      { headers: { "x-store-slug": "test-store" } },
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(mockHandler).toHaveBeenCalled();
  });

  it("POST rejects absolute callbackURL in body", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-store-slug": "test-store",
      },
      body: JSON.stringify({
        email: "user@example.com",
        callbackURL: "https://evil.com",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("callbackURL");
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("POST rejects non-string callbackURL in body (K5)", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-store-slug": "test-store",
      },
      body: JSON.stringify({
        email: "user@example.com",
        callbackURL: { url: "https://evil.com" },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("POST allows relative callbackURL in body", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-store-slug": "test-store",
      },
      body: JSON.stringify({
        email: "user@example.com",
        callbackURL: "/account",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockHandler).toHaveBeenCalled();
  });

  it("POST allows request with no callbackURL", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-store-slug": "test-store",
      },
      body: JSON.stringify({ email: "user@example.com" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockHandler).toHaveBeenCalled();
  });
});

describe("E7: customer endpoints 403 on non-store hosts", () => {
  it("GET /magic-link/verify returns 403 without x-store-slug", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/auth/magic-link/verify?token=abc&callbackURL=/account",
    );
    const res = await GET(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/store hosts/i);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("POST /sign-in/magic-link returns 403 without x-store-slug", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/store hosts/i);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("POST /sign-in/magic-link passes through on a store's custom domain", async () => {
    mockRegisteredCustomDomain.mockResolvedValueOnce("shop.mamasmarket.com");
    const req = new NextRequest("https://shop.mamasmarket.com/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-custom-domain": "shop.mamasmarket.com" },
      body: JSON.stringify({ email: "user@example.com" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("POST /sign-in/magic-link returns 403 on a custom domain no store owns", async () => {
    mockRegisteredCustomDomain.mockResolvedValueOnce(null);
    const req = new NextRequest("https://nobody.example.com/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-custom-domain": "nobody.example.com" },
      body: JSON.stringify({ email: "user@example.com" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("GET /get-session passes through without x-store-slug (non-customer path)", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/get-session");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(mockHandler).toHaveBeenCalled();
  });

  it("POST /sign-in/email passes through without x-store-slug", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", password: "pass" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockHandler).toHaveBeenCalled();
  });
});
