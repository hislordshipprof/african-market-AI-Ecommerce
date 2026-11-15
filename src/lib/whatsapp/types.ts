/** WhatsApp Cloud API message shapes this platform sends (#143). */

export type TemplateParameter = { type: "text"; text: string };

export type TemplateComponent =
  | { type: "body"; parameters: TemplateParameter[] }
  | { type: "button"; sub_type: "url"; index: string; parameters: TemplateParameter[] };

export interface ReplyButton {
  id: string;
  title: string;
}

/** `to` is the recipient's number in E.164 or its wa_id (digits only). */
export type OutboundMessage =
  | { type: "text"; to: string; body: string }
  | { type: "interactive"; to: string; body: string; buttons: ReplyButton[] }
  | { type: "template"; to: string; name: string; language: string; components?: TemplateComponent[] }
  | {
      type: "media";
      to: string;
      mediaType: "image" | "document" | "audio" | "video";
      link: string;
      caption?: string;
    };

/** Accepted by Meta. Delivery is reported later as a webhook status. */
export interface SendResult {
  messageId: string;
  /** Meta's id for the recipient, from `contacts[0].wa_id`. */
  waId: string | null;
}

/**
 * What Embedded Signup returns for a store's own number (#558): the WABA and
 * phone number ids, and the code exchanged server-side for a business token.
 * In fake mode the ids and display number come from a form and there is no code.
 */
export interface ConnectStoreNumberInput {
  wabaId: string;
  phoneNumberId: string;
  /** Number stays on the WhatsApp Business app (coexistence): not registered again. */
  coexistence: boolean;
  code?: string;
  displayNumber?: string;
}

export interface ConnectedStoreNumber {
  businessToken: string;
  displayNumber: string;
}

/** A store's own number to send from (#560): its phone_number_id and the store's business token. */
export interface WhatsAppSender {
  phoneNumberId: string;
  accessToken: string;
}

export interface WhatsAppProvider {
  /** From the store's number when `from` is given, else from the platform number. */
  send(message: OutboundMessage, from?: WhatsAppSender): Promise<SendResult>;
  /** Exchanges the code, subscribes the app to the WABA and registers the number. */
  connectStoreNumber(input: ConnectStoreNumberInput): Promise<ConnectedStoreNumber>;
}
