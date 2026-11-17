import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { signWhatsAppBody } from "@/lib/whatsapp/signature";

vi.mock("@/lib/whatsapp/inbound", () => ({
  handleInboundMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/whatsapp/store-inbound", () => ({
  handleStoreInboundMessage: vi.fn().mockResolvedValue({ kind: "customer", storeId: "s" }),
}));

import { handleInboundMessage } from "@/lib/whatsapp/inbound";
import { handleStoreInboundMessage } from "@/lib/whatsapp/store-inbound";
import { GET, POST } from "./route";

const SECRET = "route-test-app-secret";
const signatureEvents = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.map((call) => JSON.parse(String(call[0]))).filter((e) => e.event === "webhook_signature_invalid");

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
    vi.mocked(handleStoreInboundMessage).mockClear();
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

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejected = [
      await post(raw),
      await post(raw, "sha256=nothex"),
      await post(raw, signWhatsAppBody(raw, "another-secret")),
      await post(raw, signWhatsAppBody(reserialised, SECRET)),
      await post(raw, signWhatsAppBody(raw, SECRET).replace("sha256=", "sha1=")),
    ];
    for (const res of rejected) expect(res.status).toBe(401);
    expect(signatureEvents(warn)).toHaveLength(5);
    expect(signatureEvents(warn)[0]).toEqual({ event: "webhook_signature_invalid", provider: "whatsapp", ip: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(signWhatsAppBody(raw, "another-secret"));
    warn.mockRestore();
    expect(handleInboundMessage).not.toHaveBeenCalled();

    const accepted = await post(raw, signWhatsAppBody(raw, SECRET));
    expect(accepted.status).toBe(200);
    expect(handleInboundMessage).toHaveBeenCalledTimes(1);
    expect(handleInboundMessage).toHaveBeenCalledWith({
      id: "wamid.route-1",
      from: "14045550123",
      fromUserId: null,
      type: "text",
      text: "À bọnọ\n",
      timestamp: 1762700000,
      replyId: null,
      inGroup: false,
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

  it("routes by metadata.phone_number_id: the platform number to the owner path, any other number to the store path", async () => {
    const STORE_PHONE_ID = "2233445566";
    const change = (phoneNumberId: string | undefined, id: string) => ({
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        ...(phoneNumberId ? { metadata: { phone_number_id: phoneNumberId } } : {}),
        messages: [{ from: "14045550123", id, timestamp: "1762700000", type: "text", text: { body: "hi" } }],
      },
    });
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [change(PHONE_ID, "wamid.owner"), change(STORE_PHONE_ID, "wamid.customer"), change(undefined, "wamid.none")] }],
    });
    const res = await post(raw, signWhatsAppBody(raw, SECRET));
    expect(res.status).toBe(200);
    expect(handleInboundMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handleInboundMessage).mock.calls[0][0].id).toBe("wamid.owner");
    expect(handleStoreInboundMessage).toHaveBeenCalledTimes(1);
    expect(handleStoreInboundMessage).toHaveBeenCalledWith(STORE_PHONE_ID, {
      id: "wamid.customer",
      from: "14045550123",
      fromUserId: null,
      type: "text",
      text: "hi",
      timestamp: 1762700000,
      replyId: null,
      inGroup: false,
    });
  });

  it("a store message is still checked against the signature first, and a handler failure answers 500", async () => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "2233445566" },
        messages: [{ from: "14045550123", id: "wamid.c2", type: "text", text: { body: "hi" } }],
      } }] }],
    });
    expect((await post(raw, signWhatsAppBody(raw, "wrong"))).status).toBe(401);
    expect(handleStoreInboundMessage).not.toHaveBeenCalled();
    vi.mocked(handleStoreInboundMessage).mockRejectedValueOnce(new Error("db down"));
    expect((await post(raw, signWhatsAppBody(raw, SECRET))).status).toBe(500);
  });

  it("store numbers still route when the platform number is not configured", async () => {
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "");
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "2233445566" },
        messages: [{ from: "14045550123", id: "wamid.c3", type: "text", text: { body: "hi" } }],
      } }] }],
    });
    expect((await post(raw, signWhatsAppBody(raw, SECRET))).status).toBe(200);
    expect(handleStoreInboundMessage).toHaveBeenCalledTimes(1);
    expect(handleInboundMessage).not.toHaveBeenCalled();
  });

  it("a failing message does not stop the later messages in the payload; the answer is still 500 (F5)", async () => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: PHONE_ID },
        messages: [
          { from: "14045550123", id: "wamid.bad", type: "text", text: { body: "hi" } },
          { from: "14045550123", id: "wamid.next", type: "text", text: { body: "hi" } },
        ],
      } }] }],
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(handleInboundMessage).mockRejectedValueOnce(new Error("bad row"));
    expect((await post(raw, signWhatsAppBody(raw, SECRET))).status).toBe(500);
    expect(vi.mocked(handleInboundMessage).mock.calls.map(([message]) => message.id)).toEqual(["wamid.bad", "wamid.next"]);
    errorLog.mockRestore();
  });

  it("an odd status does not drop the message beside it, and an unreadable message logs its key names only (F13, F15)", async () => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: PHONE_ID },
        messages: [
          { from: "14045550123", id: "wamid.good", type: "text", text: { body: "hi" } },
          { from: "14045550123", kind: "text", body: "private words" },
        ],
        statuses: [{ id: "wamid.s", status: "failed", errors: [{ code: "131047" }] }],
      } }] }],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await post(raw, signWhatsAppBody(raw, SECRET))).status).toBe(200);
    expect(vi.mocked(handleInboundMessage).mock.calls.map(([message]) => message.id)).toEqual(["wamid.good"]);
    const lines = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(lines).toEqual([{ event: "whatsapp_message_unparsed", count: 1, keys: [["body", "from", "kind"]] }]);
    warn.mockRestore();
  });
});
