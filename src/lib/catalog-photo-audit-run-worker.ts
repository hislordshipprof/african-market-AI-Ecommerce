import { deletePhotoAuditRun, insertNamedPhotoAuditFixtures } from "./catalog-photo-audit-fixtures";
import { disconnectPlatformClient, platformAdminTransaction } from "./db";

function redact(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-url]");
}

async function main(): Promise<void> {
  const [command, prefix] = process.argv.slice(2);
  if ((command !== "insert" && command !== "delete") || !prefix || !/^[a-z0-9]+$/.test(prefix)) {
    process.stderr.write("usage: insert|delete <prefix>\n");
    process.exit(2);
  }
  if (command === "insert") {
    await platformAdminTransaction(async (tx) => {
      await insertNamedPhotoAuditFixtures(tx, prefix);
    });
  } else {
    await deletePhotoAuditRun(prefix);
  }
  process.stdout.write(`${command} ${prefix}\n`);
  await disconnectPlatformClient();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "worker failed";
  process.stderr.write(`${redact(message)}\n`);
  process.exit(1);
});
