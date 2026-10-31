import { describe, it, expect, beforeEach } from "vitest";
import { sendEmail, getTestSentEmails, clearTestSentEmails } from "./send";

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
