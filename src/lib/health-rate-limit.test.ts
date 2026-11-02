import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isRateLimited, resetRateLimiter } from "./rate-limit";

describe("isRateLimited", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRateLimiter();
  });

  it("resetRateLimiter lets an exhausted IP through again", () => {
    for (let i = 0; i < 10; i++) {
      isRateLimited("172.16.0.1");
    }
    expect(isRateLimited("172.16.0.1")).toBe(true);

    resetRateLimiter();
    expect(isRateLimited("172.16.0.1")).toBe(false);
  });

  it("allows up to 10 requests per IP within a minute", () => {
    for (let i = 0; i < 10; i++) {
      expect(isRateLimited("192.168.1.1")).toBe(false);
    }
  });

  it("blocks the 11th request within a minute", () => {
    for (let i = 0; i < 10; i++) {
      isRateLimited("192.168.1.2");
    }
    expect(isRateLimited("192.168.1.2")).toBe(true);
  });

  it("allows requests again after the window expires", () => {
    for (let i = 0; i < 10; i++) {
      isRateLimited("192.168.1.3");
    }
    expect(isRateLimited("192.168.1.3")).toBe(true);

    vi.advanceTimersByTime(61_000);
    expect(isRateLimited("192.168.1.3")).toBe(false);
  });

  it("tracks IPs independently", () => {
    for (let i = 0; i < 10; i++) {
      isRateLimited("10.0.0.1");
    }
    expect(isRateLimited("10.0.0.1")).toBe(true);
    expect(isRateLimited("10.0.0.2")).toBe(false);
  });
});
