async function main(): Promise<void> {
  await import("./db.ts");
  process.stdout.write("imported-without-throw\n");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "import failed";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
