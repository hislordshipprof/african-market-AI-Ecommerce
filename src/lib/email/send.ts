export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
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
        from: this.from,
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

function createSender(): EmailSender {
  if (process.env.NODE_ENV === "test" || process.env.CI === "true") {
    return new TestSender();
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "onboarding@resend.dev";

  if (!apiKey) {
    console.warn("RESEND_API_KEY not set — emails will be logged to console");
    return new TestSender();
  }

  return new ResendSender(apiKey, from);
}

const sender = createSender();

export async function sendEmail(message: EmailMessage): Promise<{ id: string }> {
  return sender.send(message);
}
