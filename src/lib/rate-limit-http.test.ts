import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Rate limit HTTP (Better Auth handler)", () => {
  let prisma: PrismaClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let testAuth: { handler: (request: Request) => Promise<Response> } & Record<string, any>;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    prisma = new PrismaClient({ adapter });
    await prisma.$connect();

    await prisma.rateLimit.deleteMany({
      where: { key: { startsWith: "rate-limit-http-test" } },
    });

    testAuth = betterAuth({
      baseURL: "http://localhost:3000",
      database: prismaAdapter(prisma, { provider: "postgresql" }),
      emailAndPassword: { enabled: true },
      rateLimit: {
        storage: "database",
        modelName: "rateLimit",
        window: 60,
        max: 2,
        customRules: {
          "/sign-in/email": { window: 60, max: 2 },
        },
      },
      trustedOrigins: ["http://localhost:3000"],
    });
  });

  afterAll(async () => {
    await prisma.rateLimit.deleteMany({
      where: { key: { startsWith: "rate-limit-http-test" } },
    });
    await prisma.$disconnect();
  });

  it("returns 429 after exceeding sign-in rate limit", async () => {
    const url = "http://localhost:3000/api/auth/sign-in/email";
    const body = JSON.stringify({
      email: "rate-limit-http-test@example.com",
      password: "WrongPassword1!",
    });
    const headers = {
      "Content-Type": "application/json",
      "X-Forwarded-For": `rate-limit-http-test-${Date.now()}`,
    };

    const responses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const req = new Request(url, { method: "POST", headers, body });
      const res = await testAuth.handler(req);
      responses.push(res.status);
    }

    const rateLimited = responses.filter((s) => s === 429);
    expect(rateLimited.length).toBeGreaterThanOrEqual(1);

    const firstTwo = responses.slice(0, 2);
    expect(firstTwo.every((s) => s !== 429)).toBe(true);
  });
});
