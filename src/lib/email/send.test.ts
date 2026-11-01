import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  sendEmail,
  getTestSentEmails,
  clearTestSentEmails,
  ResendSender,
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
    await sendEmail({ to: "a@example.com", subject: "First", html: "" });
    await sendEmail({ to: "b@example.com", subject: "Second", html: "" });

    expect(getTestSentEmails()).toHaveLength(2);
  });

  it("clearTestSentEmails resets the inbox", async () => {
    await sendEmail({ to: "a@example.com", subject: "Test", html: "" });
    clearTestSentEmails();
    expect(getTestSentEmails()).toHaveLength(0);
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
