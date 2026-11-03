export interface SmsMessage {
  to: string;
  body: string;
}

export interface SmsSender {
  send(message: SmsMessage): Promise<void>;
}

export class TelnyxSender implements SmsSender {
  private apiKey: string;
  private from: string;

  constructor(apiKey: string, from: string) {
    this.apiKey = apiKey;
    this.from = from;
  }

  async send(message: SmsMessage): Promise<void> {
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: message.to,
        text: message.body,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telnyx API error ${res.status}: ${body}`);
    }
  }
}

const sent: SmsMessage[] = [];

class TestSender implements SmsSender {
  async send(message: SmsMessage): Promise<void> {
    sent.push(message);
  }
}

class DevLogSender implements SmsSender {
  async send(message: SmsMessage): Promise<void> {
    sent.push(message);
    console.info(`[SMS → ${message.to}] ${message.body}`);
  }
}

export function getTestSentSms(): readonly SmsMessage[] {
  return sent;
}

export function clearTestSentSms(): void {
  sent.length = 0;
}

export function createSmsSender(
  env: Record<string, string | undefined> = process.env,
): SmsSender | null {
  if (env.NEXT_PHASE === "phase-production-build") {
    return new TestSender();
  }

  if (env.NODE_ENV === "test" || env.CI === "true") {
    return new TestSender();
  }

  const apiKey = env.TELNYX_API_KEY;
  const from = env.TELNYX_FROM_NUMBER;

  if (!apiKey || !from) {
    if (env.NODE_ENV === "production") {
      console.warn(
        "TELNYX_API_KEY or TELNYX_FROM_NUMBER not set — phone sign-in will be unavailable",
      );
      return null;
    }
    console.warn("TELNYX_API_KEY/TELNYX_FROM_NUMBER not set — SMS will be logged to console");
    return new DevLogSender();
  }

  return new TelnyxSender(apiKey, from);
}

const senderInstance = createSmsSender();

export function getSmsSender(): SmsSender | null {
  return senderInstance;
}

export async function sendSms(message: SmsMessage): Promise<void> {
  if (!senderInstance) {
    throw new Error("SMS is not configured — TELNYX_API_KEY and TELNYX_FROM_NUMBER are required");
  }
  return senderInstance.send(message);
}
