import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindUnique = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockFindMany = vi.fn();
const mockAuditCreate = vi.fn();

vi.mock("../db", () => ({
  platformAdmin: {
    store: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
    auditLog: {
      create: (...args: unknown[]) => mockAuditCreate(...args),
    },
  },
}));

vi.mock("../get-store", () => ({
  revalidateStore: vi.fn(),
}));

vi.mock("./session", () => ({
  requirePlatformAdmin: vi.fn().mockResolvedValue({
    user: { id: "admin-1", email: "admin@platform.test", role: "platform_admin", twoFactorEnabled: true },
  }),
}));

import { createStore, updateStore, suspendStore } from "./actions";

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    fd.set(k, v);
  }
  return fd;
}

const VALID_STORE = {
  slug: "mama-ngozi",
  name: "Mama Ngozi African Market",
  themePreset: "palm-and-shea",
  status: "active",
  prepTimeMinutes: "30",
  deliveryRadiusMi: "8",
  minimumOrder: "35",
  autoRefundLimit: "25",
};

describe("createStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects empty slug", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, slug: "" }));
    expect(result.fieldErrors?.slug).toBeDefined();
  });

  it("lowercases slug before validation", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "upper",
      name: "Mama Ngozi African Market",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore({}, formData({ ...VALID_STORE, slug: "UPPER" }));
    expect(result.success).toBe(true);
    expect(mockCreate.mock.calls[0][0].data.slug).toBe("upper");
  });

  it("rejects slug starting with hyphen", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, slug: "-bad" }));
    expect(result.fieldErrors?.slug).toBeDefined();
  });

  it("rejects slug with special characters", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, slug: "bad slug!" }));
    expect(result.fieldErrors?.slug).toBeDefined();
  });

  it("rejects empty name", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, name: "" }));
    expect(result.fieldErrors?.name).toBeDefined();
  });

  it("rejects invalid hex color", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, brandColor: "red" }),
    );
    expect(result.fieldErrors?.brandColor).toBeDefined();
  });

  it("accepts valid hex color", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "mama-ngozi",
      name: "Mama Ngozi African Market",
      brandColor: "#1F5A43",
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, brandColor: "#1F5A43" }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects duplicate slug", async () => {
    mockFindUnique.mockResolvedValueOnce({ id: "existing", slug: "mama-ngozi" });

    const result = await createStore({}, formData(VALID_STORE));
    expect(result.fieldErrors?.slug).toContain("already exists");
  });

  it("succeeds with valid data and writes audit log", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    const createdStore = {
      id: "store-1",
      slug: "mama-ngozi",
      name: "Mama Ngozi African Market",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    };
    mockCreate.mockResolvedValueOnce(createdStore);
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore({}, formData(VALID_STORE));
    expect(result.success).toBe(true);
    expect(result.storeId).toBe("store-1");
    expect(mockAuditCreate).toHaveBeenCalledOnce();
    expect(mockAuditCreate.mock.calls[0][0].data.action).toBe("store.create");
    expect(mockAuditCreate.mock.calls[0][0].data.actorId).toBe("admin-1");
  });

  it("nudges brand color and reports it", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    const createdStore = {
      id: "store-1",
      slug: "test-store",
      name: "Test",
      brandColor: "#EEEEEE",
      themePreset: "palm-and-shea",
      status: "active",
    };
    mockCreate.mockResolvedValueOnce(createdStore);
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, slug: "test-store", name: "Test", brandColor: "#EEEEEE" }),
    );
    expect(result.success).toBe(true);
    expect(result.brandColorNudged).toBe(true);
    expect(result.nudgedColor).toBeDefined();
  });

  it("rejects invalid theme preset", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, themePreset: "nope" }),
    );
    expect(result.fieldErrors?.themePreset).toBeDefined();
  });

  it("rejects prep time out of range", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, prepTimeMinutes: "500" }),
    );
    expect(result.fieldErrors?.prepTimeMinutes).toBeDefined();
  });

  it("rejects delivery radius out of range", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, deliveryRadiusMi: "20" }),
    );
    expect(result.fieldErrors?.deliveryRadiusMi).toBeDefined();
  });

  it("rejects invalid hours JSON", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, hours: "not json" }),
    );
    expect(result.fieldErrors?.hours).toBeDefined();
  });

  it("accepts zero for minimumOrder", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "zero-min",
      name: "Zero Min Store",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, slug: "zero-min", name: "Zero Min Store", minimumOrder: "0" }),
    );
    expect(result.success).toBe(true);
    expect(mockCreate.mock.calls[0][0].data.minimumOrderCents).toBe(0);
  });

  it("accepts zero for autoRefundLimit", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "zero-refund",
      name: "Zero Refund Store",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, slug: "zero-refund", name: "Zero Refund Store", autoRefundLimit: "0" }),
    );
    expect(result.success).toBe(true);
    expect(mockCreate.mock.calls[0][0].data.autoRefundLimitCents).toBe(0);
  });

  it("accepts zero for prepTimeMinutes", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "zero-prep",
      name: "Zero Prep Store",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, slug: "zero-prep", name: "Zero Prep Store", prepTimeMinutes: "0" }),
    );
    expect(result.success).toBe(true);
    expect(mockCreate.mock.calls[0][0].data.prepTimeMinutes).toBe(0);
  });

  it("accepts zero for deliveryRadiusMi", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "zero-radius",
      name: "Zero Radius Store",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, slug: "zero-radius", name: "Zero Radius Store", deliveryRadiusMi: "0" }),
    );
    expect(result.success).toBe(true);
    expect(mockCreate.mock.calls[0][0].data.deliveryRadiusMi).toBe(0);
  });

  it("rejects non-numeric minimumOrder", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, minimumOrder: "abc" }),
    );
    expect(result.fieldErrors?.minimumOrder).toBeDefined();
  });

  it("rejects reserved slug 'admin'", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, slug: "admin" }));
    expect(result.fieldErrors?.slug).toContain("reserved");
  });

  it("rejects reserved slug 'www'", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, slug: "www" }));
    expect(result.fieldErrors?.slug).toContain("reserved");
  });

  it("rejects reserved slug 'api'", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, slug: "api" }));
    expect(result.fieldErrors?.slug).toContain("reserved");
  });

  it("rejects remote logo URL when LOGO_HOSTS is not set", async () => {
    const original = process.env.LOGO_HOSTS;
    delete process.env.LOGO_HOSTS;
    try {
      const result = await createStore(
        {},
        formData({ ...VALID_STORE, logoUrl: "https://example.com/logo.png" }),
      );
      expect(result.fieldErrors?.logoUrl).toBeDefined();
    } finally {
      if (original !== undefined) process.env.LOGO_HOSTS = original;
    }
  });

  it("accepts local logo path", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "local-logo",
      name: "Local Logo Store",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, slug: "local-logo", name: "Local Logo Store", logoUrl: "/logos/my-logo.svg" }),
    );
    expect(result.success).toBe(true);
  });

  it("clears hours when input is empty", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "no-hours",
      name: "No Hours Store",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, slug: "no-hours", name: "No Hours Store", hours: "" }),
    );
    expect(result.success).toBe(true);
    const createArg = mockCreate.mock.calls[0][0].data;
    expect(createArg.hours).toBeDefined();
  });
});

describe("updateStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when storeId is missing", async () => {
    const result = await updateStore({}, formData(VALID_STORE));
    expect(result.error).toBeDefined();
  });

  it("returns error when store not found", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    const result = await updateStore(
      {},
      formData({ ...VALID_STORE, storeId: "nonexistent" }),
    );
    expect(result.error).toContain("not found");
  });

  it("detects slug conflict on update", async () => {
    const before = { id: "store-1", slug: "old-slug", name: "Old" };
    mockFindUnique.mockResolvedValueOnce(before);
    mockFindUnique.mockResolvedValueOnce({ id: "store-2", slug: "taken" });

    const result = await updateStore(
      {},
      formData({ ...VALID_STORE, storeId: "store-1", slug: "taken" }),
    );
    expect(result.fieldErrors?.slug).toContain("already exists");
  });

  it("succeeds and writes audit log with before/after", async () => {
    const before = {
      id: "store-1",
      slug: "mama-ngozi",
      name: "Old Name",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    };
    mockFindUnique.mockResolvedValueOnce(before);

    const updated = {
      ...before,
      name: "Mama Ngozi African Market",
      status: "active",
    };
    mockUpdate.mockResolvedValueOnce(updated);
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await updateStore(
      {},
      formData({ ...VALID_STORE, storeId: "store-1" }),
    );
    expect(result.success).toBe(true);
    expect(mockAuditCreate).toHaveBeenCalledOnce();
    const auditData = mockAuditCreate.mock.calls[0][0].data;
    expect(auditData.action).toBe("store.update");
    expect(auditData.before).toBeDefined();
    expect(auditData.after).toBeDefined();
  });
});

describe("suspendStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when store not found", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    const result = await suspendStore("nonexistent");
    expect(result.error).toContain("not found");
  });

  it("suspends an active store and writes audit log", async () => {
    const before = { id: "store-1", slug: "mama-ngozi", status: "active" };
    mockFindUnique.mockResolvedValueOnce(before);
    mockUpdate.mockResolvedValueOnce({ ...before, status: "suspended" });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await suspendStore("store-1");
    expect(result.success).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "store-1" },
      data: { status: "suspended" },
    });
    const auditData = mockAuditCreate.mock.calls[0][0].data;
    expect(auditData.action).toBe("store.suspend");
    expect(auditData.before).toEqual({ status: "active" });
    expect(auditData.after).toEqual({ status: "suspended" });
  });

  it("unsuspends a suspended store", async () => {
    const before = { id: "store-1", slug: "mama-ngozi", status: "suspended" };
    mockFindUnique.mockResolvedValueOnce(before);
    mockUpdate.mockResolvedValueOnce({ ...before, status: "active" });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await suspendStore("store-1");
    expect(result.success).toBe(true);
    const auditData = mockAuditCreate.mock.calls[0][0].data;
    expect(auditData.action).toBe("store.unsuspend");
  });
});
