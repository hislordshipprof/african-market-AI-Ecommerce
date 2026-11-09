import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { signWhatsAppBody } from "@/lib/whatsapp/signature";

vi.mock("@/lib/whatsapp/inbound", () => ({
  handleInboundMessage: vi.fn().mockResolvedValue(undefined),
}));

import { handleInboundMessage } from "@/lib/whatsapp/inbound";
import { GET, POST } from "./route";

const SECRET = "route-test-app-secret";
const VERIFY = "route-test-verify-token";
const PHONE_ID = "1029384756";
const URL_BASE = "http://localhost:3000/api/webhooks/whatsapp";

function challenge(params: Record<string, string>) {
  const url = new URL(URL_BASE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return GET(new NextRequest(url));
}

function post(body: string, signature?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== undefined) headers["x-hub-signature-256"] = signature;
  return POST(new NextRequest(URL_BASE, { method: "POST", body, headers }));
}

describe("WhatsApp webhook route", () => {
  beforeEach(() => {
    vi.stubEnv("WHATSAPP_APP_SECRET", SECRET);
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", VERIFY);
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", PHONE_ID);
    vi.mocked(handleInboundMessage).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("GET echoes the challenge only for the configured verify token", async () => {
    const ok = await challenge({ "hub.mode": "subscribe", "hub.verify_token": VERIFY, "hub.challenge": "1158201444" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await ok.text()).toBe("1158201444");

    const refused: Array<Record<string, string>> = [
      { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" },
      { "hub.mode": "unsubscribe", "hub.verify_token": VERIFY, "hub.challenge": "1" },
      { "hub.mode": "subscribe", "hub.verify_token": VERIFY },
    ];
    for (const params of refused) {
      const res = await challenge(params);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("1");
    }

    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", "");
    const emptyAgainstEmpty = await challenge({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "7" });
    expect(emptyAgainstEmpty.status).toBe(403);
    const anyAgainstUnset = await challenge({ "hub.mode": "subscribe", "hub.verify_token": "x", "hub.challenge": "7" });
    expect(anyAgainstUnset.status).toBe(403);
  });

  it("POST rejects a missing or wrong signature before any handler runs, and accepts the exact raw body", async () => {
    // Meta signs the body as sent: escaped non-ASCII and its own whitespace.
    const raw = `{"object":"whatsapp_business_account",  "entry":[{"id":"1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"${PHONE_ID}"},"contacts":[{"profile":{"name":"Ad\\u00e1 \\u00d2b\\u00ed"},"wa_id":"14045550123"}],"messages":[{"from":"14045550123","id":"wamid.route-1","timestamp":"1762700000","type":"text","text":{"body":"\\u00c0 b\\u1ecdn\\u1ecd\\n"}}]}}]}]}\n`;
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(reserialised).not.toBe(raw);

    const rejected = [
      await post(raw),
      await post(raw, "sha256=nothex"),
      await post(raw, signWhatsAppBody(raw, "another-secret")),
      await post(raw, signWhatsAppBody(reserialised, SECRET)),
      await post(raw, signWhatsAppBody(raw, SECRET).replace("sha256=", "sha1=")),
    ];
    for (const res of rejected) expect(res.status).toBe(401);
    expect(handleInboundMessage).not.toHaveBeenCalled();

    const accepted = await post(raw, signWhatsAppBody(raw, SECRET));
    expect(accepted.status).toBe(200);
    expect(handleInboundMessage).toHaveBeenCalledTimes(1);
    expect(handleInboundMessage).toHaveBeenCalledWith({
      id: "wamid.route-1",
      from: "14045550123",
      type: "text",
      text: "À bọnọ\n",
    });

    vi.stubEnv("WHATSAPP_APP_SECRET", "");
    const unconfigured = await post(raw, signWhatsAppBody(raw, ""));
    expect(unconfigured.status).toBe(503);
    expect(handleInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("a statuses-only payload returns 200 and calls no handler", async () => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        id: "1",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: PHONE_ID },
            statuses: [
              { id: "wamid.out-1", status: "delivered", recipient_id: "14045550123", timestamp: "1762700001" },
              { id: "wamid.out-2", status: "failed", recipient_id: "14045550123", errors: [{ code: 131026, title: "x" }] },
            ],
          },
        }],
      }],
    });
    const res = await post(raw, signWhatsAppBody(raw, SECRET));
    expect(res.status).toBe(200);
    expect(handleInboundMessage).not.toHaveBeenCalled();
  });
});
