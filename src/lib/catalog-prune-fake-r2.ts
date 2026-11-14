import { CATALOG_PRUNE_BATCH_SIZE } from "./catalog-prune";

export type R2SendClient = {
  send(command: unknown): Promise<unknown>;
};

export type RecordedR2Command = {
  name: string;
  input: { Bucket?: string; Delete?: { Objects?: { Key?: string }[]; Quiet?: boolean } };
};

type StoredObject = { key: string; lastModified: Date | null };

/**
 * In-memory S3/R2 stand-in. It rejects what R2 rejects: an empty or oversized
 * DeleteObjects body, the wrong bucket, and commands it does not implement.
 * A missing key is reported under Deleted. Configured failures come back as
 * Errors with HTTP-200 semantics (the promise resolves). Key match is case-sensitive.
 */
export function createFakeR2(options: {
  bucket: string;
  objects: StoredObject[];
  errorKeys?: ReadonlySet<string>;
  /** 1-based DeleteObjects call that throws before changing stored keys. */
  throwOnBatch?: number;
  /** 1-based DeleteObjects call that removes keys and then throws. */
  loseResponseOnBatch?: number;
  /** Leave this requested key out of Deleted and Errors. */
  omitKeyFromResponse?: string;
  listFault?: "missing-token" | "repeat-token" | "throw-on-second-page";
}): { send: (command: unknown) => Promise<unknown>; recorded: RecordedR2Command[]; objects: () => StoredObject[] } {
  const stored = options.objects.map((object) => ({ ...object }));
  const recorded: RecordedR2Command[] = [];
  let deleteCalls = 0;

  async function send(command: unknown): Promise<unknown> {
    const name = commandName(command);
    const input = commandInput(command);
    recorded.push({ name, input });
    if (name === "ListObjectsV2") return list(input);
    if (name === "DeleteObjects") return remove(input);
    throw new Error(`Unknown command ${name || "Unknown"}`);
  }

  function list(input: CommandInput) {
    assertBucket(input.Bucket);
    const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
    const maxKeys = Math.min(typeof input.MaxKeys === "number" ? input.MaxKeys : CATALOG_PRUNE_BATCH_SIZE, CATALOG_PRUNE_BATCH_SIZE);
    const matching = stored.filter((object) => object.key.startsWith(prefix));
    const token = typeof input.ContinuationToken === "string" ? input.ContinuationToken : "";
    const offset = token ? Number(token.replace("page-", "")) : 0;
    if (options.listFault === "throw-on-second-page" && offset > 0) {
      throw new Error("list failed");
    }
    const page = matching.slice(offset, offset + maxKeys);
    const truncated = offset + maxKeys < matching.length;
    let next: string | undefined;
    if (truncated) {
      if (options.listFault === "missing-token") next = undefined;
      else if (options.listFault === "repeat-token") next = "page-0";
      else next = `page-${offset + maxKeys}`;
    }
    return {
      Contents: page.map((object) => ({
        Key: object.key,
        LastModified: object.lastModified ?? undefined,
      })),
      IsTruncated: truncated,
      NextContinuationToken: next,
      $metadata: {},
    };
  }

  function remove(input: CommandInput) {
    assertBucket(input.Bucket);
    const objects = input.Delete?.Objects ?? [];
    if (objects.length < 1 || objects.length > CATALOG_PRUNE_BATCH_SIZE) {
      throw new Error("MalformedXML");
    }
    deleteCalls += 1;
    const keys = objects.map((object) => object.Key ?? "");
    if (options.throwOnBatch === deleteCalls) throw new Error("transport failed");
    const deleted: { Key: string }[] = [];
    const errors: { Key: string; Code: string; Message: string }[] = [];
    for (const key of keys) {
      if (options.omitKeyFromResponse === key) continue;
      if (options.errorKeys?.has(key)) {
        errors.push({ Key: key, Code: "AccessDenied", Message: "Access Denied" });
        continue;
      }
      const index = stored.findIndex((object) => object.key === key);
      if (index >= 0) stored.splice(index, 1);
      deleted.push({ Key: key });
    }
    if (options.loseResponseOnBatch === deleteCalls) {
      throw new Error("response lost");
    }
    return { Deleted: deleted, Errors: errors, $metadata: { httpStatusCode: 200 } };
  }

  function assertBucket(bucket: unknown) {
    if (bucket !== options.bucket) throw new Error("NoSuchBucket");
  }

  return {
    send,
    recorded,
    objects: () => stored.map((object) => ({ ...object })),
  };
}

export function commandName(command: unknown): string {
  const input = (command as { input?: { Delete?: unknown; Prefix?: unknown; MaxKeys?: unknown } } | null)?.input;
  if (input && "Delete" in input) return "DeleteObjects";
  if (input && ("Prefix" in input || "MaxKeys" in input || "ContinuationToken" in input)) return "ListObjectsV2";
  const name = (command as { constructor?: { name?: string } } | null)?.constructor?.name ?? "";
  return name || "Unknown";
}

function commandInput(command: unknown): CommandInput {
  return ((command as { input?: CommandInput } | null)?.input ?? {}) as CommandInput;
}

type CommandInput = {
  Bucket?: string;
  Prefix?: string;
  ContinuationToken?: string;
  MaxKeys?: number;
  Delete?: { Objects?: { Key?: string }[]; Quiet?: boolean };
};
