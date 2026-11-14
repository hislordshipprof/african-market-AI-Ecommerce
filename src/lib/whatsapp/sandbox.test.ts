import { describe, expect, it } from "vitest";
import { cloudApiWhatsAppProvider } from "./provider";
import { HELLO_WORLD_TEMPLATE } from "./templates";

const recipient = process.env.WHATSAPP_TEST_RECIPIENT?.trim();
const hasKeys = Boolean(
  process.env.WHATSAPP_ACCESS_TOKEN?.trim() && process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() && recipient,
);

describe.skipIf(!hasKeys)(
  "WhatsApp Cloud API sandbox (skipped unless WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TEST_RECIPIENT are set)",
  () => {
    it("sends the hello_world template to the test recipient and gets a message id and wa_id", async () => {
      const result = await cloudApiWhatsAppProvider.send({
        type: "template",
        to: recipient!,
        name: HELLO_WORLD_TEMPLATE.name,
        language: HELLO_WORLD_TEMPLATE.language,
      });
      expect(result.messageId).toMatch(/^wamid\./);
      expect(result.waId).toMatch(/^\d{8,15}$/);
    });
  },
);
