import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudApiWhatsAppProvider, GRAPH_API_VERSION, toGraphPayload } from "./provider";
import { ORDER_UPDATE_TEMPLATES, orderUpdateMessage, ownerLinkCodeMessage } from "./templates";

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
          message: "(#131026) Message undeliverable to 14045550123",
          type: "OAuthException",
          code: 131026,
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
    expect(failure).toMatchObject({ code: 131026, status: 400 });
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

  it("the real Embedded Signup adapter exchanges the code, subscribes the app, sets the PIN then registers with that same PIN, and skips both under coexistence", async () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "platform-token");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "1029384756");
    vi.stubEnv("WHATSAPP_APP_ID", "app-123");
    vi.stubEnv("WHATSAPP_APP_SECRET", "app-secret");
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/oauth/access_token")) return json({ access_token: "business-token", token_type: "bearer" });
      if (url.endsWith("/subscribed_apps")) return json({ success: true });
      if (url.endsWith("/register")) return json({ success: true });
      if (init?.method === "POST") return json({ success: true });
      return json({ display_phone_number: "+1 404-555-0101", id: "2233445566" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getWhatsAppProvider } = await import("./index");

    const connected = await getWhatsAppProvider().connectStoreNumber({
      wabaId: "778899", phoneNumberId: "2233445566", coexistence: false, code: "es-code",
    });
    expect(connected).toEqual({ businessToken: "business-token", displayNumber: "+1 404-555-0101" });
    const calls = fetchMock.mock.calls.map(([url]) => url as string);
    const exchange = new URL(calls[0]);
    expect(exchange.pathname).toBe(`/${GRAPH_API_VERSION}/oauth/access_token`);
    expect(Object.fromEntries(exchange.searchParams)).toEqual({ client_id: "app-123", client_secret: "app-secret", code: "es-code" });
    expect(calls[1]).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/778899/subscribed_apps`);
    expect(calls[2]).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/2233445566`);
    const setPin = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    expect(setPin[1].method).toBe("POST");
    const pin = (JSON.parse(setPin[1].body as string) as { pin: string }).pin;
    expect(pin).toMatch(/^\d{6}$/);
    expect(calls[3]).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/2233445566/register`);
    const register = fetchMock.mock.calls[3] as unknown as [string, RequestInit];
    expect((register[1].headers as Record<string, string>).Authorization).toBe("Bearer business-token");
    expect(JSON.parse(register[1].body as string)).toEqual({ messaging_product: "whatsapp", pin });

    fetchMock.mockClear();
    await getWhatsAppProvider().connectStoreNumber({
      wabaId: "778899", phoneNumberId: "2233445566", coexistence: true, code: "es-code-2",
    });
    expect(fetchMock.mock.calls.map(([url]) => url as string).some((url) => url.endsWith("/register"))).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => url as string)).not.toContain(`https://graph.facebook.com/${GRAPH_API_VERSION}/2233445566`);
  });

  it("the real Embedded Signup adapter throws at call time without the app id, and maps a Graph error without its message", async () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "platform-token");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "1029384756");
    vi.stubEnv("WHATSAPP_APP_SECRET", "app-secret");
    vi.stubEnv("WHATSAPP_APP_ID", "");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 100, message: "Invalid code es-code" } }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const { getWhatsAppProvider } = await import("./index");
    const { WhatsAppApiError, WhatsAppNotConfiguredError } = await import("./errors");
    const input = { wabaId: "778899", phoneNumberId: "2233445566", coexistence: true, code: "es-code" };

    await expect(getWhatsAppProvider().connectStoreNumber(input)).rejects.toBeInstanceOf(WhatsAppNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("WHATSAPP_APP_ID", "app-123");
    const error = await getWhatsAppProvider().connectStoreNumber(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhatsAppApiError);
    expect((error as Error).message).not.toContain("es-code");
    expect((error as InstanceType<typeof WhatsAppApiError>).code).toBe(100);
  });

  it("sends from a store's own number with the store's token, not the platform's (#560)", async () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "platform-token");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "1029384756");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.1" }], contacts: [{ wa_id: "14045550123" }] })));
    vi.stubGlobal("fetch", fetchMock);
    await cloudApiWhatsAppProvider.send(
      orderUpdateMessage("+14045550123", ORDER_UPDATE_TEMPLATES.placed, "Ada", "order/tok"),
      { phoneNumberId: "5556667778", accessToken: "store-token" },
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/5556667778/messages`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer store-token");
  });
  it("a list message is Meta's interactive list with one section of rows (#559)", () => {
    expect(toGraphPayload({
      type: "list",
      to: "+14045550123",
      body: "Pick one",
      button: "Choose",
      rows: [{ id: "Garri (2 kg)", title: "Garri", description: "2 kg · $5.99" }, { id: "Yam (1 tuber)", title: "Yam" }],
    })).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "14045550123",
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "Pick one" },
        action: {
          button: "Choose",
          sections: [{
            title: "Choices",
            rows: [
              { id: "Garri (2 kg)", title: "Garri", description: "2 kg · $5.99" },
              { id: "Yam (1 tuber)", title: "Yam" },
            ],
          }],
        },
      },
    });
  });
});
