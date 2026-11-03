export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Display name plus address. Falls back to the sender default. */
  from?: string;
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
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: message.from ?? this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
      }),
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

class TestSender implements EmailSender {
  async send(message: EmailMessage): Promise<{ id: string }> {
    sent.push(message);
    return { id: `test-${Date.now()}` };
  }
}

export function getTestSentEmails(): readonly EmailMessage[] {
  return sent;
}

export function clearTestSentEmails(): void {
  sent.length = 0;
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
    if (env.NODE_ENV === "production") {
      throw new Error(
        "RESEND_API_KEY is required in production. " +
          "All transactional emails (invites, order confirmations) will fail without it.",
      );
    }
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
