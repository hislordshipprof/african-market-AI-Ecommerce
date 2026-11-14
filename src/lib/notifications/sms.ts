import { ProviderSendError } from "./provider-error";

export interface SmsMessage {
  to: string;
  from: string;
  text: string;
}

export interface SmsSendOptions {
  idempotencyKey: string;
}

export interface SmsSender {
  send(message: SmsMessage, options: SmsSendOptions): Promise<{ id: string; replayed?: boolean }>;
}

const E164 = /^\+[1-9]\d{1,14}$/;
const KEY = /^[A-Za-z0-9_-]{1,255}$/;
const sent: SmsMessage[] = [];
const smsKeys = new Map<string, { id: string; body: string }>();
const optedOut = new Set<string>();

export function getTestSentSms(): readonly SmsMessage[] {
  return sent;
}

export function clearTestSentSms(): void {
  sent.length = 0;
  smsKeys.clear();
}

/** Test double only. Telnyx 40300 is a profile-wide STOP. */
export function markSmsOptedOutForTests(e164: string): void {
  optedOut.add(e164);
}

function smsBody(message: SmsMessage): string {
  return JSON.stringify({ to: message.to, from: message.from, text: message.text });
}

export class SmsTestSender implements SmsSender {
  async send(message: SmsMessage, options: SmsSendOptions): Promise<{ id: string }> {
    if (!E164.test(message.to)) throw new ProviderSendError(403, "40310");
    if (!message.text.trim()) throw new ProviderSendError(400, "empty_text");
    if (!message.from.trim()) throw new ProviderSendError(400, "missing_from");
    if (!KEY.test(options.idempotencyKey)) throw new ProviderSendError(400, "10015");
    if (optedOut.has(message.to)) throw new ProviderSendError(403, "40300");
    const body = smsBody(message);
    const prior = smsKeys.get(options.idempotencyKey);
    if (prior) {
      if (prior.body !== body) throw new ProviderSendError(422, "idempotency_conflict");
      return { id: prior.id };
    }
    const id = `sms-${smsKeys.size + 1}`;
    smsKeys.set(options.idempotencyKey, { id, body });
    sent.push(message);
    return { id };
  }
}

export class TelnyxSender implements SmsSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: SmsMessage, options: SmsSendOptions): Promise<{ id: string; replayed: boolean }> {
    let res: Response;
    try {
      res = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": options.idempotencyKey,
        },
        body: JSON.stringify({
          from: message.from || this.from,
          to: message.to,
          text: message.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") throw new ProviderSendError(0, "timeout");
      throw new ProviderSendError(0, "network");
    }
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const body = (await res.json()) as { errors?: Array<{ code?: string | number }> };
        const found = body.errors?.[0]?.code;
        if (typeof found === "string" || typeof found === "number") code = String(found);
      } catch {
        // Keep the status code. Never keep Telnyx's detail: it echoes both numbers.
      }
      throw new ProviderSendError(res.status, code);
    }
    const data = (await res.json()) as { data?: { id?: string } };
    const id = data.data?.id;
    if (!id) throw new ProviderSendError(res.status, "missing_id");
    return { id, replayed: res.headers.get("Idempotent-Replayed") === "true" };
  }
}

export function createSmsSender(
  env: Record<string, string | undefined> = process.env,
): SmsSender | null {
  if (env.NEXT_PHASE === "phase-production-build" || env.NODE_ENV === "test" || env.CI === "true") {
    return new SmsTestSender();
  }
  if (!env.TELNYX_API_KEY || !env.TELNYX_FROM_NUMBER) return null;
  return new TelnyxSender(env.TELNYX_API_KEY, env.TELNYX_FROM_NUMBER);
}

let testSender: SmsSender | null = null;

export function setSmsSenderForTests(next: SmsSender | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setSmsSenderForTests is only available when NODE_ENV=test");
  }
  testSender = next;
}

export function smsSender(env: Record<string, string | undefined> = process.env): SmsSender | null {
  return testSender ?? createSmsSender(env);
}
