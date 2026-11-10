import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

let currentSlug = "";
vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(currentSlug ? { "x-store-slug": currentSlug } : {}) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("notFound"); } }));

const bucket = vi.hoisted(() => new Map<string, { body: Uint8Array; contentType: string }>());
vi.mock("@aws-sdk/client-s3", () => {
  class GetObjectCommand {
    constructor(readonly input: { Bucket: string; Key: string }) {}
  }
  class PutObjectCommand {
    constructor(readonly input: { Key: string }) {}
  }
  class S3Client {
    async send(command: GetObjectCommand) {
      const object = bucket.get(`${command.input.Bucket}/${command.input.Key}`);
      if (!object) throw new Error("NoSuchKey");
      return {
        ContentType: object.contentType,
        Body: { transformToWebStream: () => new Blob([object.body as BlobPart]).stream() },
      };
    }
  }
  return { S3Client, GetObjectCommand, PutObjectCommand };
});

import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "@/lib/db";
import { GET } from "./route";

const hasDb = !!process.env.DATABASE_URL;
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

describe.skipIf(!hasDb)("GET /api/delivery-proof/[token]", () => {
  let raw: PrismaClient;
  const stamp = Date.now().toString(36);
  const slugA = `t134-proof-a-${stamp}`;
  const slugB = `t134-proof-b-${stamp}`;
  let storeAId = "";
  let storeBId = "";
  let deliveredToken = "";
  let deliveredId = "";
  let noProofToken = "";

  const call = (slug: string, token: string) => {
    currentSlug = slug;
    return GET(new Request(`http://localhost/api/delivery-proof/${token}`), {
      params: Promise.resolve({ token }),
    });
  };

  async function order(storeId: string, n: number, token: string) {
    const customer = await storeScoped(storeId).customer.create({
      data: { storeId, name: "Ada", email: `ada-${n}@example.com` },
    });
    return storeScoped(storeId).order.create({
      data: {
        storeId,
        customerId: customer.id,
        number: n,
        status: "OUT_FOR_DELIVERY",
        fulfillment: "store-delivery",
        subtotalCents: 100,
        bufferCents: 0,
        totalCents: 100,
        totalAuthorizedCents: 100,
        trackingToken: token,
      },
    });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    const [a, b] = await Promise.all([
      raw.store.create({ data: { slug: slugA, name: "Proof A", themePreset: "palm-and-shea" } }),
      raw.store.create({ data: { slug: slugB, name: "Proof B", themePreset: "palm-and-shea" } }),
    ]);
    storeAId = a.id;
    storeBId = b.id;
    deliveredToken = `tok-delivered-${stamp}`;
    noProofToken = `tok-noproof-${stamp}`;
    const delivered = await order(storeAId, 1, deliveredToken);
    deliveredId = delivered.id;
    const key = `delivery-proof/${delivered.id}/1762700000000.jpg`;
    await storeScoped(storeAId).order.update({ where: { id: delivered.id }, data: { status: "DELIVERED", deliveryProofKey: key } });
    bucket.set(`proof-bucket/${key}`, { body: PHOTO, contentType: "image/jpeg" });
    await order(storeAId, 2, noProofToken);
  });

  beforeEach(() => {
    process.env.R2_ACCOUNT_ID = "test-account";
    process.env.R2_ACCESS_KEY_ID = "test-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret";
    process.env.R2_BUCKET = "catalog-bucket";
    vi.stubEnv("R2_PROOF_BUCKET", "proof-bucket");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    for (const id of [storeAId, storeBId].filter(Boolean)) {
      await storeScoped(id).order.deleteMany({});
      await storeScoped(id).customer.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: [storeAId, storeBId].filter(Boolean) } } });
    await raw.$disconnect();
  });

  it("the order's tracking token on its own store returns the photo bytes, private and not sniffable", async () => {
    const response = await call(slugA, deliveredToken);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PHOTO);
  });

  it("an unknown token, another store's token, or an order with no proof is 404", async () => {
    expect((await call(slugA, "tok-unknown")).status).toBe(404);
    expect((await call(slugB, deliveredToken)).status).toBe(404);
    expect((await call(slugA, noProofToken)).status).toBe(404);
  });

  it("the delivered order's id is not its tracking token: 404", async () => {
    expect((await call(slugA, deliveredId)).status).toBe(404);
    expect((await call(slugA, deliveredToken)).status).toBe(200);
  });

  it("with no private proof bucket configured the photo is 404", async () => {
    vi.stubEnv("R2_PROOF_BUCKET", "");
    expect((await call(slugA, deliveredToken)).status).toBe(404);
  });
});
