import { describe, it, expect, vi, afterAll } from "vitest";

// The real config, as production runs it: Better Auth only rate-limits in production.
vi.hoisted(() => {
  delete process.env.AUTH_RATE_LIMIT_RELAXED;
  (process.env as Record<string, string>).NODE_ENV = "production";
  process.env.BETTER_AUTH_SECRET ||= "test-secret-at-least-32-characters-long!!";
  process.env.EMAIL_FROM ||= "Rate Limit Test <signin@test.example>";
});
// Production would pick the live Resend sender: record sends instead.
const { sent } = vi.hoisted(() => ({ sent: [] as { to: string; html?: string }[] }));
vi.mock("./email/send", () => ({
  sendEmail: async (message: { to: string; html?: string }) => {
    sent.push(message);
  },
}));
import { auth } from "./auth";
import { authPrisma } from "./db";
import { verifyUrlFromEmail } from "./test-magic-link";

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const slug = `rl-${stamp}`;

function sendLink(email: string, ip: string, name?: string): Promise<Response> {
  return auth.handler(
    new Request("http://localhost:3000/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": ip,
        "x-store-slug": slug,
        host: `${slug}.localhost:3000`,
      },
      body: JSON.stringify({ email, name, callbackURL: "/account" }),
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

  it("blocked sends do not count, so a slow trickle never leaves the inbox without a live link", async () => {
    const email = `rl-trickle-${stamp}@test.example`;
    emails.push(email);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start);
      for (let i = 0; i < 6; i++) await sendLink(email, `10.183.${i}.1`);
      for (let i = 1; i <= 18; i++) {
        vi.setSystemTime(start + i * 100_000);
        await sendLink(email, `10.184.${i}.1`);
      }
      vi.setSystemTime(start + 1_850_000);
      expect((await sendLink(email, "10.185.0.1")).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const latest = sent.filter((message) => message.to === email).at(-1);
      const token = new URL(verifyUrlFromEmail(latest?.html)!).searchParams.get("token");
      const row = await authPrisma.verification.findFirst({
        where: { identifier: `magic-link:${token}` },
      });
      expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  it("links sent elsewhere with the victim's address as the name do not count against the victim", async () => {
    const victim = `rl-victim-${stamp}@test.example`;
    emails.push(victim);
    for (let i = 0; i < 6; i++) {
      const attacker = `rl-att-${i}-${stamp}@test.example`;
      emails.push(attacker);
      expect((await sendLink(attacker, `10.186.${i}.1`, victim)).status).toBe(200);
    }
    const forged = await authPrisma.verification.findFirst({
      where: { value: { contains: `rl-att-0-${stamp}@` } },
    });
    expect(JSON.parse(forged!.value).name).toBeFalsy();
    expect((await sendLink(victim, "10.187.0.1")).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent.filter((message) => message.to === victim)).toHaveLength(1);
  });

  // `_` matches any one character in LIKE; `%` addresses are refused by the email check (test below).
  it.each([
    ["digits", (i: number) => `${i}`],
    ["a dot", () => "."],
  ])("links to look-alike inboxes (%s) do not count against an address containing _", async (kind, lookAlike) => {
    const tag = kind.replace(" ", "");
    const victim = `rl_${tag}-${stamp}@test.example`;
    emails.push(victim);
    for (let i = 0; i < 6; i++) {
      const other = `rl${lookAlike(i)}${tag}-${stamp}@test.example`;
      emails.push(other);
      expect((await sendLink(other, `10.188.${i}.${kind.length}`)).status).toBe(200);
    }
    expect((await sendLink(victim, `10.189.0.${kind.length}`)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent.filter((message) => message.to === victim)).toHaveLength(1);
  });

  it("an address containing % is refused before any link is stored", async () => {
    const victim = `rl%pct-${stamp}@test.example`;
    expect((await sendLink(victim, "10.189.1.1")).status).toBe(400);
    expect(await authPrisma.verification.count({ where: { value: { contains: `pct-${stamp}` } } })).toBe(0);
    expect(sent.filter((message) => message.to === victim)).toHaveLength(0);
  });
});
