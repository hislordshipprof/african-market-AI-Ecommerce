/** The kinds a customer notification can use. The recorder inserts one row per kind. */
export const NOTIFICATION_CHANNEL_KINDS = ["email", "sms", "push"] as const;

export type NotificationChannelKind = (typeof NOTIFICATION_CHANNEL_KINDS)[number];
