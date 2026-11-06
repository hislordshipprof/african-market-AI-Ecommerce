/**
 * Opt-in live check for one photo and one PDF. local-ci and Playwright force
 * this off. It never runs unless ASSISTANT_LIVE_TESTS=1.
 */
if (process.env.ASSISTANT_LIVE_TESTS !== "1") {
  process.stdout.write(JSON.stringify({ skipped: true }));
  process.exit(0);
}

const { readFileSync } = await import("node:fs");
const { createAssistantModel } = await import("../src/lib/assistant/model.ts");
const { prepareAttachments } = await import("../src/lib/assistant/attachments.ts");

const jpeg = readFileSync(new URL("../src/lib/assistant/fixtures/list-exif.jpg", import.meta.url));
const pdf = readFileSync(new URL("../src/lib/assistant/fixtures/two-page.pdf", import.meta.url));
const prepared = await prepareAttachments([
  { name: "list.jpg", mediaType: "image/jpeg", bytes: jpeg },
  { name: "recipe.pdf", mediaType: "application/pdf", bytes: pdf },
]);
if (!prepared.ok) {
  process.stderr.write(prepared.code);
  process.exit(1);
}

const { generateText } = await import("ai");
const model = createAssistantModel();
let cacheRead = 0;
let cacheWrite = 0;
let input = 0;
let output = 0;
for (const file of prepared.files) {
  const result = await generateText({
    model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Name the items you can see. Do not change a cart." },
        file.mediaType === "application/pdf"
          ? { type: "file", data: file.modelBytes, mediaType: "application/pdf" }
          : { type: "image", image: file.modelBytes, mediaType: "image/jpeg" },
      ],
    }],
    maxOutputTokens: 80,
  });
  input += result.usage.inputTokens ?? 0;
  output += result.usage.outputTokens ?? 0;
  const details = result.usage.inputTokenDetails;
  cacheRead += details?.cacheReadTokens ?? 0;
  cacheWrite += details?.cacheWriteTokens ?? 0;
}
process.stdout.write(JSON.stringify({ skipped: false, input, output, cacheRead, cacheWrite }));
