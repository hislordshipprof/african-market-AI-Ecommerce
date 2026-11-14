import { sendEmail } from "../email/send";
import { productionRuntime } from "../inngest/event-key";
import { ProviderSendError } from "./provider-error";
import { normalizeUsPhone } from "./phone";
import { pushSender } from "../push/sender";
import { pushToOrder } from "../push/order-subscriptions";
import { renderEmail, renderPush, renderSms, type NotifyOrder, type RenderedMessage } from "./messages";
import { smsSender, type SmsSender } from "./sms";
import type { NotificationChannelKind } from "./channel-kinds";
import type { OrderNotifyEvent } from "./record";

export type ChannelResult =
  | { outcome: "sent"; providerMessageId: string }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string; retryable: boolean };

export interface NotificationChannel {
  kind: NotificationChannelKind;
  prepare(
    order: NotifyOrder,
    event: OrderNotifyEvent,
    url: string,
    env: Record<string, string | undefined>,
  ): ChannelResult | { outcome: "ready"; message: RenderedMessage };
  send(message: RenderedMessage, options: { idempotencyKey: string }): Promise<ChannelResult>;
}

const logged = new Set<string>();

function logOnce(reason: string, orderId: string, channel: string): void {
  if (logged.has(reason)) return;
  logged.add(reason);
  console.error(JSON.stringify({ event: reason, orderId, channel, reason }));
}

function sinkMode(env: Record<string, string | undefined>): boolean {
  return env.NEXT_PHASE === "phase-production-build" || env.NODE_ENV === "test" || env.CI === "true";
}

function previewEnv(env: Record<string, string | undefined>): boolean {
  return env.VERCEL_ENV === "preview";
}

function sandboxEmail(to: string): boolean {
  return to === "delivered@resend.dev" || /^delivered\+[^@]+@resend\.dev$/i.test(to);
}

function mapEmailError(err: unknown): ChannelResult {
  if (err instanceof ProviderSendError) {
    if (err.code === "invalid_idempotent_request" || err.status === 409 && err.code === "invalid_idempotent_request") {
      return { outcome: "failed", reason: "idempotency_conflict", retryable: false };
    }
    if (err.code === "concurrent_idempotent_requests" || (err.status === 409 && err.code !== "invalid_idempotent_request")) {
      return { outcome: "failed", reason: "resend_409", retryable: true };
    }
    if (err.code === "timeout" || err.code === "network") {
      return { outcome: "failed", reason: "resend_timeout", retryable: true };
    }
    if (err.status === 429 && (err.code === "daily_quota_exceeded" || err.code === "monthly_quota_exceeded")) {
      return { outcome: "failed", reason: "resend_quota", retryable: false };
    }
    if (err.status === 429 || err.status >= 500 || err.status === 0) {
      return { outcome: "failed", reason: `resend_${err.status || "timeout"}`, retryable: true };
    }
    return { outcome: "failed", reason: err.code || `resend_${err.status}`, retryable: false };
  }
  if (err instanceof Error) {
    const match = /^Resend API error (\d+): ([\s\S]*)$/.exec(err.message);
    if (match) {
      const status = Number(match[1]);
      let name = "";
      try {
        const body = JSON.parse(match[2]) as { name?: string };
        name = typeof body.name === "string" ? body.name : "";
      } catch {
        name = "";
      }
      return mapEmailError(new ProviderSendError(status, name || `http_${status}`));
    }
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { outcome: "failed", reason: "resend_timeout", retryable: true };
    }
  }
  return { outcome: "failed", reason: "provider_error", retryable: true };
}

function mapSmsError(err: unknown): ChannelResult {
  if (!(err instanceof ProviderSendError)) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { outcome: "failed", reason: "telnyx_timeout", retryable: true };
    }
    return { outcome: "failed", reason: "provider_error", retryable: true };
  }
  if (err.code === "40300") return { outcome: "skipped", reason: "opted_out" };
  if (err.code === "timeout" || err.code === "network") {
    return { outcome: "failed", reason: "telnyx_timeout", retryable: true };
  }
  if (err.status === 409 || err.code === "10016" || err.code === "40006" || err.code === "40008") {
    return { outcome: "failed", reason: err.code === "10016" ? "telnyx_10016" : `telnyx_${err.code}`, retryable: true };
  }
  if (err.status === 422) return { outcome: "failed", reason: "idempotency_conflict", retryable: false };
  if (err.status >= 500 || err.status === 0) {
    return { outcome: "failed", reason: "telnyx_5xx", retryable: true };
  }
  return { outcome: "failed", reason: err.code, retryable: false };
}

async function settle(result: ChannelResult): Promise<ChannelResult> {
  if (result.outcome === "failed" && result.retryable) {
    throw new Error(result.reason);
  }
  return result;
}

export const emailChannel: NotificationChannel = {
  kind: "email",
  prepare(order, event, url, env) {
    const email = order.customer.email?.trim() ?? "";
    if (!email) return { outcome: "skipped", reason: "no_email" };
    if (previewEnv(env) && !sandboxEmail(email)) {
      logOnce("preview_recipient", order.id, "email");
      return { outcome: "skipped", reason: "preview_recipient" };
    }
    if (!sinkMode(env) && productionRuntime(env) && !env.RESEND_API_KEY) {
      logOnce("email_not_configured", order.id, "email");
      return { outcome: "failed", reason: "email_not_configured", retryable: false };
    }
    if (!sinkMode(env) && productionRuntime(env) && !env.EMAIL_FROM) {
      logOnce("email_from_missing", order.id, "email");
      return { outcome: "skipped", reason: "email_from_missing" };
    }
    const from = env.EMAIL_FROM ?? "onboarding@resend.dev";
    return { outcome: "ready", message: renderEmail({ ...order, customer: { ...order.customer, email } }, event, url, from) };
  },
  async send(message, options) {
    try {
      const sent = await sendEmail({
        to: message.to,
        subject: message.subject ?? "",
        html: message.html ?? "",
        from: message.from,
        idempotencyKey: options.idempotencyKey,
      });
      return { outcome: "sent", providerMessageId: sent.id };
    } catch (err) {
      return settle(mapEmailError(err));
    }
  },
};

export const smsChannel: NotificationChannel = {
  kind: "sms",
  prepare(order, event, url, env) {
    const phone = normalizeUsPhone(order.customer.phone);
    if (!phone.ok) return { outcome: "skipped", reason: phone.reason };
    if (previewEnv(env) && phone.e164 !== env.TELNYX_TEST_TO) {
      logOnce("preview_recipient", order.id, "sms");
      return { outcome: "skipped", reason: "preview_recipient" };
    }
    if (!smsSender(env)) {
      logOnce("sms_not_configured", order.id, "sms");
      return { outcome: "skipped", reason: "sms_not_configured" };
    }
    const rendered = renderSms(order, event, url);
    return {
      outcome: "ready",
      message: { ...rendered, to: phone.e164, from: env.TELNYX_FROM_NUMBER ?? "test-from" },
    };
  },
  async send(message, options) {
    const sender: SmsSender | null = smsSender();
    if (!sender) return { outcome: "skipped", reason: "sms_not_configured" };
    try {
      const sent = await sender.send(
        { to: message.to, from: message.from ?? "", text: message.text ?? "" },
        options,
      );
      return { outcome: "sent", providerMessageId: sent.id };
    } catch (err) {
      return settle(mapSmsError(err));
    }
  },
};

/** Web push to the devices that opted in on the tracking page (#563). */
export const pushChannel: NotificationChannel = {
  kind: "push",
  prepare(order, event, url, env) {
    if (!pushSender(env)) return { outcome: "skipped", reason: "push_not_configured" };
    return { outcome: "ready", message: renderPush(order, event, url) };
  },
  async send(message) {
    if (!message.push) return { outcome: "skipped", reason: "no_subscription" };
    const { storeId, orderId, message: payload } = message.push;
    const result = await pushToOrder(storeId, orderId, payload);
    if (result.sent > 0) return { outcome: "sent", providerMessageId: `push:${result.sent}` };
    if (result.failed > 0) return settle({ outcome: "failed", reason: "push_failed", retryable: result.retryable });
    return { outcome: "skipped", reason: "no_subscription" };
  },
};

export const notificationChannels: NotificationChannel[] = [emailChannel, smsChannel, pushChannel];
