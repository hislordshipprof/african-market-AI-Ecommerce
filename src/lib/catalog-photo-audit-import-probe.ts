import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { S3Client } from "@aws-sdk/client-s3";

function blocked(kind: string): () => never {
  return () => {
    throw new Error(`unexpected ${kind}`);
  };
}

net.Socket.prototype.connect = blocked("socket") as typeof net.Socket.prototype.connect;
http.request = blocked("http") as typeof http.request;
https.request = blocked("https") as typeof https.request;

const require = createRequire(pathToFileURL(path.join(process.cwd(), "package.json")).href);
const sdk = require("@aws-sdk/client-s3") as { S3Client: typeof S3Client };
const OriginalS3Client = sdk.S3Client;
let s3ClientConstructions = 0;
sdk.S3Client = class CountingS3Client extends OriginalS3Client {
  constructor(...args: ConstructorParameters<typeof OriginalS3Client>) {
    s3ClientConstructions += 1;
    super(...args);
  }
};

async function main(): Promise<void> {
  const { httpStatusOf, statusLabel } = await import("./catalog-photo-audit");
  if (s3ClientConstructions !== 0) {
    throw new Error(`S3Client constructed ${s3ClientConstructions} time(s) during core import`);
  }

  if (
    process.env.R2_ACCOUNT_ID
    || process.env.R2_ACCESS_KEY_ID
    || process.env.R2_SECRET_ACCESS_KEY
    || process.env.R2_BUCKET
  ) {
    throw new Error("R2 configuration was present");
  }
  if (process.env.NODE_ENV !== "production" || process.env.VERCEL !== "1") {
    throw new Error("expected a production Vercel child");
  }
  if (process.env.NEXT_PHASE) {
    throw new Error("NEXT_PHASE was set");
  }

  const numeric = httpStatusOf({ $metadata: { httpStatusCode: 403 } });
  if (numeric !== 403) throw new Error(`numeric status ${String(numeric)}`);
  const text = httpStatusOf({ $metadata: { httpStatusCode: "404" } });
  if (text !== undefined) throw new Error("string status was accepted");
  const nan = httpStatusOf({ $metadata: { httpStatusCode: Number.NaN } });
  if (!Number.isNaN(nan)) throw new Error("NaN status was dropped");
  if (statusLabel({ name: "TimeoutError" }) !== "timeout") throw new Error("timeout label changed");
  if (statusLabel({ name: "TimeoutError", $metadata: { httpStatusCode: 503 } }) !== "HTTP 503") {
    throw new Error("numeric status lost to timeout name");
  }

  process.stdout.write("core-import-ok\n");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "core import failed";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
