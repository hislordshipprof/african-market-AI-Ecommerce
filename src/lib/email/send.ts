import { ProviderSendError } from "../notifications/provider-error";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Display name plus address. Falls back to the sender default. */
  from?: string;
  /** Resend keeps this for 24 hours. The same key and body replay the same id. */
  idempotencyKey?: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<{ id: string }>;
}

export class ResendSender implements EmailSender {
  private apiKey: string;
  private from: string;

  constructor(apiKey: string, from: string) {
    this.apiKey = apiKey;
    this.from = from;
  }

  async send(message: EmailMessage): Promise<{ id: string }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (message.idempotencyKey) headers["Idempotency-Key"] = message.idempotencyKey;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: message.from ?? this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Resend API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { id: string };
    return { id: data.id };
  }
}

const sent: EmailMessage[] = [];
const emailKeys = new Map<string, { id: string; body: string }>();

function emailBody(message: EmailMessage): string {
  return JSON.stringify({
    to: message.to,
    subject: message.subject,
    html: message.html,
    from: message.from ?? null,
  });
}

export class TestSender implements EmailSender {
  async send(message: EmailMessage): Promise<{ id: string }> {
    if (!message.to?.trim() || !message.subject?.trim() || !message.html?.trim()) {
      throw new ProviderSendError(400, "validation_error");
    }
    const key = message.idempotencyKey;
    if (key !== undefined) {
      if (key.length < 1 || key.length > 256) throw new ProviderSendError(400, "invalid_key");
      const body = emailBody(message);
      const prior = emailKeys.get(key);
      if (prior) {
        if (prior.body !== body) throw new ProviderSendError(409, "invalid_idempotent_request");
        return { id: prior.id };
      }
      const id = `test-${emailKeys.size + 1}-${Date.now()}`;
      emailKeys.set(key, { id, body });
      sent.push(message);
      return { id };
    }
    sent.push(message);
    return { id: `test-${Date.now()}` };
  }
}

export function getTestSentEmails(): readonly EmailMessage[] {
  return sent;
}

export function clearTestSentEmails(): void {
  sent.length = 0;
  emailKeys.clear();
}

class UnconfiguredSender implements EmailSender {
  async send(): Promise<{ id: string }> {
    throw new Error(
      "RESEND_API_KEY is required in production. " +
        "All transactional emails (invites, order confirmations) will fail without it.",
    );
  }
}

export function createSender(
  env: Record<string, string | undefined> = process.env,
): EmailSender {
  if (env.NEXT_PHASE === "phase-production-build") {
    return new TestSender();
  }

  if (env.NODE_ENV === "test" || env.CI === "true") {
    return new TestSender();
  }

  const apiKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM ?? "onboarding@resend.dev";

  if (!apiKey) {
    if (env.NODE_ENV === "production") return new UnconfiguredSender();
    console.warn("RESEND_API_KEY not set — emails will be logged to console");
    return new TestSender();
  }

  return new ResendSender(apiKey, from);
}

const sender = createSender();

let testSender: EmailSender | null = null;

/** Vitest-only seam so a slow or failing sender can be observed. */
export function setEmailSenderForTests(next: EmailSender | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setEmailSenderForTests is only available when NODE_ENV=test");
  }
  testSender = next;
}

export async function sendEmail(message: EmailMessage): Promise<{ id: string }> {
  return (testSender ?? sender).send(message);
}
