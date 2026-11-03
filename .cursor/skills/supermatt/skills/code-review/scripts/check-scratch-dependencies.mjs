#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const [directory, ...packages] = process.argv.slice(2);
if (!directory || packages.length === 0) {
  console.error("Usage: check-scratch-dependencies.mjs <directory> <required-package>...");
  process.exitCode = 2;
} else {
  const requireFromScratch = createRequire(resolve(directory, "package.json"));
  for (const name of packages) {
    try {
      console.log(`${name}: ${realpathSync(requireFromScratch.resolve(name))}`);
    } catch (error) {
      console.error(`Cannot resolve ${name} from ${resolve(directory)}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
