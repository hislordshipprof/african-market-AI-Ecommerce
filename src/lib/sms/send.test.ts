import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TelnyxSender,
  createSmsSender,
  getTestSentSms,
  clearTestSentSms,
} from "./send";

beforeEach(() => {
  clearTestSentSms();
});

describe("createSmsSender", () => {
  it("returns TestSender in NODE_ENV=test", () => {
    const sender = createSmsSender({ NODE_ENV: "test" });
    expect(sender).not.toBeNull();
  });

  it("returns TestSender when CI=true", () => {
    const sender = createSmsSender({ CI: "true" });
    expect(sender).not.toBeNull();
  });

  it("returns null in production without Telnyx config", () => {
    const sender = createSmsSender({ NODE_ENV: "production" });
    expect(sender).toBeNull();
  });

  it("returns null when only API key is set but no from number", () => {
    const sender = createSmsSender({
      NODE_ENV: "production",
      TELNYX_API_KEY: "key",
    });
    expect(sender).toBeNull();
  });

  it("returns TelnyxSender when both env vars are set", () => {
    const sender = createSmsSender({
      NODE_ENV: "production",
      TELNYX_API_KEY: "key",
      TELNYX_FROM_NUMBER: "+15555551234",
    });
    expect(sender).toBeInstanceOf(TelnyxSender);
  });

  it("returns TestSender in dev without config", () => {
    const sender = createSmsSender({ NODE_ENV: "development" });
    expect(sender).not.toBeNull();
    expect(sender).not.toBeInstanceOf(TelnyxSender);
  });

  it("dev sender logs to console", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const sender = createSmsSender({ NODE_ENV: "development" });
    await sender!.send({ to: "+12025551234", body: "Code: 123456" });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("+12025551234"),
    );
    spy.mockRestore();
  });
});

describe("TestSender (in test env)", () => {
  it("captures sent messages", async () => {
    const sender = createSmsSender({ NODE_ENV: "test" });
    await sender!.send({ to: "+12025551234", body: "Code: 123456" });
    const sent = getTestSentSms();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ to: "+12025551234", body: "Code: 123456" });
  });

  it("clears captured messages", async () => {
    const sender = createSmsSender({ NODE_ENV: "test" });
    await sender!.send({ to: "+12025551234", body: "test" });
    clearTestSentSms();
    expect(getTestSentSms()).toHaveLength(0);
  });
});

describe("TelnyxSender", () => {
  it("sends to Telnyx API", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "msg-123" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const sender = new TelnyxSender("test-key", "+15555550000");
    await sender.send({ to: "+12025551234", body: "Your code is 123456" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("https://api.telnyx.com/v2/messages");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({
      from: "+15555550000",
      to: "+12025551234",
      text: "Your code is 123456",
    });
    expect(opts.headers.Authorization).toBe("Bearer test-key");

    vi.unstubAllGlobals();
  });

  it("throws on API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: () => Promise.resolve("Invalid phone number"),
      }),
    );

    const sender = new TelnyxSender("test-key", "+15555550000");
    await expect(
      sender.send({ to: "bad", body: "test" }),
    ).rejects.toThrow(/Telnyx API error 422/);

    vi.unstubAllGlobals();
  });
});
