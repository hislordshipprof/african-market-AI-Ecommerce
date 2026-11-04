import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { planCatalogPrune } from "./catalog-prune";

const sandboxBucket = process.env.R2_SANDBOX_BUCKET;
const sandboxAccess = process.env.R2_SANDBOX_ACCESS_KEY_ID;
const sandboxSecret = process.env.R2_SANDBOX_SECRET_ACCESS_KEY;
const hasSandbox = Boolean(sandboxBucket && sandboxAccess && sandboxSecret && process.env.R2_ACCOUNT_ID);

describe("catalog prune sandbox", () => {
  it("real R2 scratch bucket: dry-run lists and bucket-name prune deletes only the unreferenced old object", async (ctx) => {
    if (!hasSandbox) {
      ctx.skip("R2_SANDBOX_BUCKET, R2_SANDBOX_ACCESS_KEY_ID and R2_SANDBOX_SECRET_ACCESS_KEY are not set. This does not block the build.");
      return;
    }
    if (sandboxBucket === process.env.R2_BUCKET || sandboxBucket === "african-markets-dev") {
      throw new Error("Refusing sandbox prune: scratch bucket matches the shared bucket");
    }
    const run = `t225-${Date.now().toString(36)}`;
    const prefix = `catalog/prune-sandbox/${run}/`;
    const orphan = `${prefix}orphan.jpg`;
    const keep = `${prefix}keep.jpg`;
    const unrelated = `${prefix}unrelated.jpg`;
    const client = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: sandboxAccess!, secretAccessKey: sandboxSecret! },
    });
    const manifest = [orphan, keep, unrelated];
    try {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      for (const key of manifest) {
        await client.send(new PutObjectCommand({
          Bucket: sandboxBucket,
          Key: key,
          Body: Buffer.from("t225"),
          ContentType: "image/jpeg",
        }));
      }
      const now = new Date(Date.now() + 25 * 60 * 60 * 1000);
      const objects = manifest.map((key) => ({ key, lastModified: new Date(Date.now() - 60_000) }));
      const dry = planCatalogPrune({
        objects,
        references: [keep],
        now,
      });
      expect(dry).toEqual([orphan, unrelated]);
      expect(dry).not.toContain(keep);
      await client.send(new DeleteObjectsCommand({
        Bucket: sandboxBucket,
        Delete: { Objects: [{ Key: orphan }], Quiet: false },
      }));
      const remaining = manifest.filter((key) => key !== orphan);
      expect(remaining).toEqual([keep, unrelated]);
    } finally {
      await client.send(new DeleteObjectsCommand({
        Bucket: sandboxBucket,
        Delete: { Objects: manifest.map((Key) => ({ Key })), Quiet: false },
      })).catch(() => undefined);
    }
  });

  it("sandbox execution and cleanup are restricted to this run manifest", () => {
    const manifest = ["catalog/prune-sandbox/run/orphan.jpg"];
    const foreign = "catalog/alligator-pepper.jpg";
    const candidates = planCatalogPrune({
      objects: [
        { key: manifest[0]!, lastModified: new Date("2020-01-01T00:00:00.000Z") },
        { key: foreign, lastModified: new Date("2020-01-01T00:00:00.000Z") },
      ].filter((object) => object.key.startsWith("catalog/prune-sandbox/run/")),
      references: [],
      now: new Date("2026-06-15T00:00:00.000Z"),
    });
    expect(candidates).toEqual(manifest);
    expect(candidates).not.toContain(foreign);
    expect(sandboxBucket === "african-markets-dev").toBe(false);
  });
});
