import { describe, it, expect, vi, afterAll } from "vitest";

// The real config, as production runs it: Better Auth only rate-limits in production.
vi.hoisted(() => {
  delete process.env.AUTH_RATE_LIMIT_RELAXED;
  (process.env as Record<string, string>).NODE_ENV = "production";
  process.env.BETTER_AUTH_SECRET ||= "test-secret-at-least-32-characters-long!!";
  process.env.EMAIL_FROM ||= "Rate Limit Test <signin@test.example>";
});
// Production would pick the live Resend sender: record sends instead.
const { sent } = vi.hoisted(() => ({ sent: [] as { to: string }[] }));
vi.mock("./email/send", () => ({
  sendEmail: async (message: { to: string }) => {
    sent.push(message);
  },
}));
import { auth } from "./auth";
import { authPrisma } from "./db";

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const slug = `rl-${stamp}`;

function sendLink(email: string, ip: string): Promise<Response> {
  return auth.handler(
    new Request("http://localhost:3000/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": ip,
        "x-store-slug": slug,
        host: `${slug}.localhost:3000`,
      },
      body: JSON.stringify({ email, callbackURL: "/account" }),
    }),
  );
}

describe("magic-link send caps (real auth config, production rate limits)", () => {
  const emails: string[] = [];
  afterAll(async () => {
    for (const email of emails) {
      await authPrisma.verification.deleteMany({ where: { value: { contains: email } } });
    }
    await authPrisma.rateLimit.deleteMany({ where: { key: { contains: stamp } } });
  });

  it("the sixth send from one IP in a minute returns 429", async () => {
    const ip = `10.181.${stamp.length}.${Math.floor(Math.random() * 250)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const email = `rl-ip-${i}-${stamp}@test.example`;
      emails.push(email);
      statuses.push((await sendLink(email, ip)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it("one inbox gets at most five links in ten minutes, even from rotating IPs", async () => {
    const email = `rl-inbox-${stamp}@test.example`;
    emails.push(email);
    for (let i = 0; i < 7; i++) {
      const res = await sendLink(email, `10.182.${i}.${Math.floor(Math.random() * 250)}`);
      expect(res.status).toBe(200);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent.filter((message) => message.to === email)).toHaveLength(5);
  });
});
