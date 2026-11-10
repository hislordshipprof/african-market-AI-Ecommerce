import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sendEmail,
  getTestSentEmails,
  clearTestSentEmails,
  ResendSender,
  createSender,
} from "./send";

describe("sendEmail (test double)", () => {
  beforeEach(() => {
    clearTestSentEmails();
  });

  it("records sent emails in the test inbox", async () => {
    const result = await sendEmail({
      to: "owner@example.com",
      subject: "You are invited",
      html: "<p>Click here</p>",
    });

    expect(result.id).toMatch(/^test-/);
    const sent = getTestSentEmails();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@example.com");
    expect(sent[0].subject).toBe("You are invited");
  });

  it("accumulates multiple emails", async () => {
    await sendEmail({ to: "a@example.com", subject: "First", html: "<p>First</p>" });
    await sendEmail({ to: "b@example.com", subject: "Second", html: "<p>Second</p>" });

    expect(getTestSentEmails()).toHaveLength(2);
  });

  it("clearTestSentEmails resets the inbox", async () => {
    await sendEmail({ to: "a@example.com", subject: "Test", html: "<p>Test</p>" });
    clearTestSentEmails();
    expect(getTestSentEmails()).toHaveLength(0);
  });
});

describe("createSender", () => {
  it("throws in production when RESEND_API_KEY is missing", async () => {
    const sender = createSender({ NODE_ENV: "production" });
    await expect(sender.send({ to: "a@example.com", subject: "Hi", html: "" })).rejects.toThrow(
      /RESEND_API_KEY/,
    );
  });

  it("returns TestSender in NODE_ENV=test without RESEND_API_KEY", () => {
    const sender = createSender({ NODE_ENV: "test" });
    expect(sender).not.toBeInstanceOf(ResendSender);
  });

  it("returns TestSender when CI=true without RESEND_API_KEY", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    try {
      clearTestSentEmails();
      const sender = createSender({ CI: "true", NODE_ENV: "production" });
      expect(sender).not.toBeInstanceOf(ResendSender);
      const result = await sender.send({
        to: "ci-shopper@example.com",
        subject: "Your sign-in link",
        html: "<p>CI sink</p>",
      });
      expect(result.id).toMatch(/^test-/);
      expect(getTestSentEmails()).toEqual([
        {
          to: "ci-shopper@example.com",
          subject: "Your sign-in link",
          html: "<p>CI sink</p>",
        },
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      clearTestSentEmails();
    }
  });

  it("returns TestSender in development without RESEND_API_KEY", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sender = createSender({ NODE_ENV: "development" });
    expect(sender).not.toBeInstanceOf(ResendSender);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("RESEND_API_KEY not set"),
    );
    warn.mockRestore();
  });

  it("returns TestSender during build phase even with NODE_ENV=production", () => {
    const sender = createSender({
      NODE_ENV: "production",
      NEXT_PHASE: "phase-production-build",
    });
    expect(sender).not.toBeInstanceOf(ResendSender);
  });

  it("returns ResendSender in production when RESEND_API_KEY is set", () => {
    const sender = createSender({
      NODE_ENV: "production",
      RESEND_API_KEY: "re_test_key",
    });
    expect(sender).toBeInstanceOf(ResendSender);
  });
});

describe("ResendSender", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends correct request shape and succeeds on 200", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({ id: "re_abc123" }),
      text: async () => "",
    };
    global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.resend.com/emails");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-api-key");
      expect(headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(init?.body as string);
      expect(body.from).toBe("noreply@example.com");
      expect(body.to).toBe("user@example.com");
      expect(body.subject).toBe("Welcome");
      expect(body.html).toBe("<p>Hello</p>");
      return mockResponse as Response;
    };

    const sender = new ResendSender("test-api-key", "noreply@example.com");
    const result = await sender.send({
      to: "user@example.com",
      subject: "Welcome",
      html: "<p>Hello</p>",
    });
    expect(result.id).toBe("re_abc123");
  });

  it("throws on non-2xx response", async () => {
    global.fetch = async () =>
      ({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
        json: async () => ({}),
      }) as Response;

    const sender = new ResendSender("test-api-key", "noreply@example.com");
    await expect(
      sender.send({
        to: "user@example.com",
        subject: "Fail",
        html: "<p>Fail</p>",
      }),
    ).rejects.toThrow(/Resend API error 500/);
  });
});
