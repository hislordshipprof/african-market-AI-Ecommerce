import { z } from "zod";

const optionalKey = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });

const whatsappEnvSchema = z.object({
  WHATSAPP_ACCESS_TOKEN: optionalKey,
  WHATSAPP_PHONE_NUMBER_ID: optionalKey,
  WHATSAPP_VERIFY_TOKEN: optionalKey,
  WHATSAPP_APP_SECRET: optionalKey,
});

export interface WhatsAppConfig {
  accessToken?: string;
  phoneNumberId?: string;
  verifyToken?: string;
  appSecret?: string;
}

/**
 * Reads the four WhatsApp keys. Called per use, never at import, so the app
 * builds and starts without them. An empty value counts as unset.
 */
export function readWhatsAppConfig(env: Record<string, string | undefined> = process.env): WhatsAppConfig {
  const parsed = whatsappEnvSchema.parse({
    WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_VERIFY_TOKEN: env.WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_APP_SECRET: env.WHATSAPP_APP_SECRET,
  });
  return {
    accessToken: parsed.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: parsed.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: parsed.WHATSAPP_VERIFY_TOKEN,
    appSecret: parsed.WHATSAPP_APP_SECRET,
  };
}

/** Both send keys, or null. */
export function readSendConfig(
  env: Record<string, string | undefined> = process.env,
): { accessToken: string; phoneNumberId: string } | null {
  const config = readWhatsAppConfig(env);
  if (!config.accessToken || !config.phoneNumberId) return null;
  return { accessToken: config.accessToken, phoneNumberId: config.phoneNumberId };
}
