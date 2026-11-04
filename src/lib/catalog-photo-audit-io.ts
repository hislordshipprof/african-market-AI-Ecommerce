/**
 * Wait until the chunk is flushed. process.exit before this callback truncates pipes.
 */
export async function writeComplete(stream: NodeJS.WritableStream, text: string): Promise<void> {
  if (text.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      stream.off("error", onError);
      reject(err);
    };
    stream.on("error", onError);
    try {
      stream.write(text, (err) => {
        stream.off("error", onError);
        if (err) reject(err);
        else resolve();
      });
    } catch (err) {
      stream.off("error", onError);
      reject(err instanceof Error ? err : new Error("write failed"));
    }
  });
}

/** Exit only after the caller has flushed stdout and stderr and released sockets. */
export function finishProcess(code: number): never {
  process.exitCode = code;
  process.exit(code);
}
