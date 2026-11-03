import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({
  authPrisma: {
    phoneOtpSend: {
      count: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import { authPrisma } from "./db";
import {
  checkPhoneRateLimit,
  recordPhoneOtpSend,
  PhoneRateLimitError,
} from "./phone-rate-limit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCount = (authPrisma as any).phoneOtpSend.count;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreate = (authPrisma as any).phoneOtpSend.create;

beforeEach(() => {
  mockCount.mockReset();
  mockCreate.mockReset();
});

describe("checkPhoneRateLimit", () => {
  it("passes when under both limits", async () => {
    mockCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    await expect(checkPhoneRateLimit("+12025551234")).resolves.toBeUndefined();
  });

  it("throws when 15-min limit reached", async () => {
    mockCount.mockResolvedValueOnce(3).mockResolvedValueOnce(3);
    await expect(checkPhoneRateLimit("+12025551234")).rejects.toThrow(
      PhoneRateLimitError,
    );
  });

  it("throws when daily limit reached", async () => {
    mockCount.mockResolvedValueOnce(2).mockResolvedValueOnce(10);
    await expect(checkPhoneRateLimit("+12025551234")).rejects.toThrow(
      PhoneRateLimitError,
    );
  });

  it("passes at boundary (2 of 3 in 15min, 9 of 10 daily)", async () => {
    mockCount.mockResolvedValueOnce(2).mockResolvedValueOnce(9);
    await expect(checkPhoneRateLimit("+12025551234")).resolves.toBeUndefined();
  });

  it("queries with correct time windows", async () => {
    mockCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const before = Date.now();
    await checkPhoneRateLimit("+12025551234");
    const after = Date.now();

    expect(mockCount).toHaveBeenCalledTimes(2);

    const call15m = mockCount.mock.calls[0][0];
    expect(call15m.where.phone).toBe("+12025551234");
    const gte15m = call15m.where.sentAt.gte.getTime();
    expect(gte15m).toBeGreaterThanOrEqual(before - 15 * 60 * 1000 - 100);
    expect(gte15m).toBeLessThanOrEqual(after - 15 * 60 * 1000 + 100);

    const callDay = mockCount.mock.calls[1][0];
    expect(callDay.where.phone).toBe("+12025551234");
    const gteDay = callDay.where.sentAt.gte.getTime();
    expect(gteDay).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000 - 100);
    expect(gteDay).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000 + 100);
  });
});

describe("recordPhoneOtpSend", () => {
  it("inserts a row with the phone number", async () => {
    mockCreate.mockResolvedValueOnce({ id: "rec-1", phone: "+12025551234" });
    await recordPhoneOtpSend("+12025551234");
    expect(mockCreate).toHaveBeenCalledWith({
      data: { phone: "+12025551234" },
    });
  });
});
