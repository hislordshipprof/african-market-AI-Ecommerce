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

export interface WhatsAppProvider {
  send(message: OutboundMessage): Promise<SendResult>;
}
