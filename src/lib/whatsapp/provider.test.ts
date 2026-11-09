import { afterEach, describe, expect, it, vi } from "vitest";
import { GRAPH_API_VERSION } from "./provider";
import { ownerLinkCodeMessage } from "./templates";

describe("WhatsApp provider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("the real adapter sends the authentication template payload and maps a Graph error to WhatsAppApiError without the recipient", async () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "test-token");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "1029384756");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messaging_product: "whatsapp",
        contacts: [{ input: "14045550123", wa_id: "14045550123" }],
        messages: [{ id: "wamid.ok-1" }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: "(#131030) Recipient phone number 14045550123 not in allowed list",
          type: "OAuthException",
          code: 131030,
          error_data: { details: "Recipient +14045550123 is not in the allow list" },
        },
      }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const { sendWhatsAppMessage } = await import("./index");
    const { WhatsAppApiError } = await import("./errors");

    const sent = await sendWhatsAppMessage(ownerLinkCodeMessage("+14045550123", "482913"));
    expect(sent).toEqual({ messageId: "wamid.ok-1", waId: "14045550123" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/1029384756/messages`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "14045550123",
      type: "template",
      template: {
        name: "owner_link_code",
        language: { code: "en_US" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "482913" }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "482913" }] },
        ],
      },
    });

    const failure = await sendWhatsAppMessage({ type: "text", to: "14045550123", body: "hi" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(WhatsAppApiError);
    expect(failure).toMatchObject({ code: 131030, status: 400 });
    const text = `${(failure as Error).message} ${JSON.stringify(failure)}`;
    expect(text).not.toMatch(/4045550123|0123/);
    // One call per send: no automatic retry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("no keys: import succeeds and the call throws; the fake is refused on Vercel and in production", async () => {
    for (const key of ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "E2E_FAKE_WHATSAPP"]) {
      vi.stubEnv(key, "");
    }
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const whatsapp = await import("./index");
    const { WhatsAppNotConfiguredError } = await import("./errors");
    expect(whatsapp.whatsappProviderKind()).toBe("unconfigured");
    expect(whatsapp.canSendWhatsApp()).toBe(false);
    await expect(whatsapp.sendWhatsAppMessage({ type: "text", to: "14045550123", body: "hi" }))
      .rejects.toBeInstanceOf(WhatsAppNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();

    const kind = whatsapp.whatsappProviderKind;
    expect(kind({ E2E_FAKE_WHATSAPP: "1", NODE_ENV: "test" })).toBe("fake");
    expect(kind({ E2E_FAKE_WHATSAPP: "1", NODE_ENV: "production", CI: "true" })).toBe("fake");
    expect(kind({ E2E_FAKE_WHATSAPP: "1", NODE_ENV: "test", VERCEL: "1" })).toBe("unconfigured");
    expect(kind({ E2E_FAKE_WHATSAPP: "1", NODE_ENV: "production" })).toBe("unconfigured");
    expect(kind({
      E2E_FAKE_WHATSAPP: "1",
      NODE_ENV: "production",
      WHATSAPP_ACCESS_TOKEN: "t",
      WHATSAPP_PHONE_NUMBER_ID: "1",
    })).toBe("real");
  });
});
