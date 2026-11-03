import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const mockFindFirst = vi.fn();
const mockCreate = vi.fn();

vi.mock("./db", () => ({
  storeScoped: () => ({
    customer: {
      findFirst: mockFindFirst,
      create: mockCreate,
    },
  }),
}));

import { findOrCreateCustomer } from "./customer-auth";

const fakeUser = {
  id: "user-1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  emailVerified: true,
  image: null,
  role: "customer",
  twoFactorEnabled: false,
  createdAt: new Date(),
  updatedAt: new Date(),
} as const;

beforeEach(() => {
  mockFindFirst.mockReset();
  mockCreate.mockReset();
});

describe("findOrCreateCustomer", () => {
  it("returns existing customer when one exists", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: "cust-1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+12025551234",
    });

    const result = await findOrCreateCustomer("store-1", fakeUser);

    expect(mockFindFirst).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result).toEqual({
      id: "cust-1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+12025551234",
    });
  });

  it("creates a new customer when none exists", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "cust-new",
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: null,
    });

    const result = await findOrCreateCustomer("store-1", fakeUser);

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        storeId: "store-1",
        userId: "user-1",
        name: "Ada Lovelace",
        email: "ada@example.com",
        phone: null,
      },
    });
    expect(result).toEqual({
      id: "cust-new",
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: null,
    });
  });

  it("handles P2002 race by re-reading", async () => {
    mockFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "cust-raced",
        name: "Ada Lovelace",
        email: "ada@example.com",
        phone: null,
      });

    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint", {
      code: "P2002",
      clientVersion: "0.0.0",
    });
    mockCreate.mockRejectedValueOnce(p2002);

    const result = await findOrCreateCustomer("store-1", fakeUser);

    expect(result).toEqual({
      id: "cust-raced",
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: null,
    });
    expect(mockFindFirst).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-P2002 errors", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    mockCreate.mockRejectedValueOnce(new Error("DB down"));

    await expect(findOrCreateCustomer("store-1", fakeUser)).rejects.toThrow(
      "DB down",
    );
  });
});
