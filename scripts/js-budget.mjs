// First-load JS budget for the storefront home (#629). Run after `pnpm build`, from the repo root.
// Size = sum of each first-load chunk gzipped on its own, the chunks listed for the route in
// .next/diagnostics/route-bundle-stats.json. The budget is the one value in scripts/js-budget.json.
// Tests: bash scripts/js-budget.test.sh
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const { route, budgetBytes } = JSON.parse(readFileSync(arg("--config", path.join(here, "js-budget.json")), "utf8"));
const stats = JSON.parse(readFileSync(".next/diagnostics/route-bundle-stats.json", "utf8"));
const entry = stats.find((r) => r.route === route);
if (!entry) {
  console.error(`js-budget FAILED: route ${route} is not in .next/diagnostics/route-bundle-stats.json`);
  process.exit(1);
}
const chunks = entry.firstLoadChunkPaths
  .map((p) => ({ path: p, bytes: gzipSync(readFileSync(p)).length }))
  .sort((a, b) => b.bytes - a.bytes);
const size = chunks.reduce((n, c) => n + c.bytes, 0);
const kb = (n) => `${(n / 1000).toFixed(1)} kB`;
if (size <= budgetBytes) {
  console.log(`js-budget ok: ${route} first-load JS ${kb(size)} gzipped, budget ${kb(budgetBytes)}`);
  process.exit(0);
}
console.error(`js-budget FAILED: ${route} first-load JS is over its budget (raise it in scripts/js-budget.json only in a reviewed change)`);
console.error(`size: ${size} bytes (${kb(size)} gzipped)`);
console.error(`budget: ${budgetBytes} bytes (${kb(budgetBytes)}), over by ${size - budgetBytes} bytes`);
console.error("largest chunks (gzipped):");
for (const c of chunks.slice(0, 5)) console.error(`  ${String(c.bytes).padStart(7)}  ${c.path}`);
process.exit(1);
