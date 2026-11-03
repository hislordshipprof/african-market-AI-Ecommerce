import { authPrisma as prisma } from "./db";

const WINDOW_15M_MS = 15 * 60 * 1000;
const WINDOW_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_15M = 3;
const MAX_PER_DAY = 10;

export class PhoneRateLimitError extends Error {
  constructor() {
    super("Too many requests. Please try again later.");
    this.name = "PhoneRateLimitError";
  }
}

export async function checkPhoneRateLimit(phone: string): Promise<void> {
  const now = new Date();
  const fifteenMinAgo = new Date(now.getTime() - WINDOW_15M_MS);
  const dayAgo = new Date(now.getTime() - WINDOW_DAY_MS);

  const [recent, daily] = await Promise.all([
    prisma.phoneOtpSend.count({
      where: { phone, sentAt: { gte: fifteenMinAgo } },
    }),
    prisma.phoneOtpSend.count({
      where: { phone, sentAt: { gte: dayAgo } },
    }),
  ]);

  if (recent >= MAX_PER_15M || daily >= MAX_PER_DAY) {
    throw new PhoneRateLimitError();
  }
}

export async function recordPhoneOtpSend(phone: string): Promise<void> {
  await prisma.phoneOtpSend.create({ data: { phone } });
}

export async function reservePhoneOtpSend(phone: string): Promise<void> {
  await prisma.phoneOtpSend.create({ data: { phone } });

  const now = new Date();
  const fifteenMinAgo = new Date(now.getTime() - WINDOW_15M_MS);
  const dayAgo = new Date(now.getTime() - WINDOW_DAY_MS);

  const [recent, daily] = await Promise.all([
    prisma.phoneOtpSend.count({
      where: { phone, sentAt: { gte: fifteenMinAgo } },
    }),
    prisma.phoneOtpSend.count({
      where: { phone, sentAt: { gte: dayAgo } },
    }),
  ]);

  if (recent > MAX_PER_15M || daily > MAX_PER_DAY) {
    throw new PhoneRateLimitError();
  }
}
