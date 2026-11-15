/** The kinds a customer notification can use, in the order a run tries them. */
export const NOTIFICATION_CHANNEL_KINDS = ["email", "whatsapp", "sms", "push"] as const;

export type NotificationChannelKind = (typeof NOTIFICATION_CHANNEL_KINDS)[number];

/** Every event gets these rows (push since #563). A whatsapp row is added only for an opted-in order (#560). */
export const DEFAULT_CHANNEL_KINDS = ["email", "sms", "push"] as const satisfies readonly NotificationChannelKind[];
