import { readSendConfig } from "./config";
import { WhatsAppNotConfiguredError } from "./errors";
import { fakeWhatsAppProvider } from "./fake";
import { cloudApiWhatsAppProvider } from "./provider";
import type { OutboundMessage, SendResult, WhatsAppProvider } from "./types";

export type WhatsAppSelection = "fake" | "real" | "unconfigured";

/**
 * Same rule as stripeProviderKind(): the fake only with E2E_FAKE_WHATSAPP=1,
 * never on Vercel, and never in production outside CI. Missing keys select
 * "unconfigured", which throws at call time; there is no implicit fake.
 */
export function whatsappProviderKind(env: Record<string, string | undefined> = process.env): WhatsAppSelection {
  const fake =
    env.E2E_FAKE_WHATSAPP === "1" &&
    !env.VERCEL &&
    (env.CI === "true" || env.NODE_ENV !== "production");
  if (fake) return "fake";
  return readSendConfig(env) ? "real" : "unconfigured";
}

const unconfiguredWhatsAppProvider: WhatsAppProvider = {
  send: async () => {
    throw new WhatsAppNotConfiguredError();
  },
};

let override: WhatsAppProvider | null = null;

/** Tests pass the fake; null restores selection from the environment. */
export function setWhatsAppProvider(provider: WhatsAppProvider | null): void {
  override = provider;
}

let warnedAboutFake = false;

export function getWhatsAppProvider(): WhatsAppProvider {
  if (override) return override;
  const kind = whatsappProviderKind();
  if (kind === "fake") {
    if (!warnedAboutFake) {
      warnedAboutFake = true;
      console.warn("E2E_FAKE_WHATSAPP=1 is selecting the fake WhatsApp provider. Refused on Vercel and in production.");
    }
    return fakeWhatsAppProvider;
  }
  if (kind === "real") return cloudApiWhatsAppProvider;
  return unconfiguredWhatsAppProvider;
}

/** True when a send can reach a provider. */
export function canSendWhatsApp(): boolean {
  return override !== null || whatsappProviderKind() !== "unconfigured";
}

export function sendWhatsAppMessage(message: OutboundMessage): Promise<SendResult> {
  return getWhatsAppProvider().send(message);
}

export type { OutboundMessage, SendResult, WhatsAppProvider } from "./types";
