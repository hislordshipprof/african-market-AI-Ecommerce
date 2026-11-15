/**
 * Fresh-process probe. The parent sets the environment before this process
 * starts, so the SDK import below is the cold import. Prints one JSON object.
 * Never prints credential values.
 */
import { generateText } from "ai";
import {
  AssistantConfigError,
  assistantProviderOptions,
  createAssistantModel,
} from "./model";

const phase = process.argv[2] ?? "missing-key";

async function main() {
  if (phase === "read-pdf") {
    const { readFileSync } = await import("node:fs");
    const { readPdfDocument } = await import("./pdf-document");
    const sharp = (await import("sharp")).default;
    const pdf = readFileSync(new URL("./fixtures/two-page.pdf", import.meta.url));
    const jpeg = readFileSync(new URL("./fixtures/list-exif.jpg", import.meta.url));
    const read = await readPdfDocument(pdf);
    const image = sharp(jpeg, { limitInputPixels: 16_777_216, failOn: "warning" });
    const meta = await image.metadata();
    process.stdout.write(JSON.stringify({
      pages: read.ok ? read.pages : 0,
      format: meta.format ?? "",
    }));
    return;
  }
  if (phase === "missing-key") {
    let failed = false;
    let name = "";
    try {
      createAssistantModel();
    } catch (error) {
      failed = error instanceof AssistantConfigError;
      name = error instanceof Error ? error.name : "";
    }
    process.env.ANTHROPIC_API_KEY = "sk-ant-probe-key";
    process.env.ASSISTANT_MODEL = "claude-haiku-5-5";
    let called = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      called += 1;
      return Response.json({
        id: "msg_probe",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as typeof fetch;
    const model = createAssistantModel();
    const result = await generateText({
      model,
      prompt: "hello",
      maxOutputTokens: 8,
      providerOptions: assistantProviderOptions("claude-haiku-5-5"),
    });
    globalThis.fetch = original;
    process.stdout.write(
      JSON.stringify({
        importOk: true,
        failedClosed: failed,
        errorName: name,
        laterText: result.text,
        fetchCalls: called,
      }),
    );
    return;
  }

  let name = "";
  try {
    createAssistantModel();
  } catch (error) {
    name = error instanceof Error ? error.name : "";
  }
  process.stdout.write(JSON.stringify({ importOk: true, errorName: name }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.name : "error";
  process.stderr.write(message);
  process.exit(1);
});
