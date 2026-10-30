#!/usr/bin/env node
/**
 * dsh-next-prompt — dependency-free test suite runner.
 *
 * Every check runs under the current Node executable, so the suite works both
 * locally (e.g. the Node shipped inside DSH) and in CI:
 *
 *   node test/run.mjs
 *
 * Steps:
 *   1. syntax check of the Host half (index.js, ESM)
 *   2. syntax check of the browser bundle (lib/client.js, script/CJS-factory)
 *   3. Host black-box acceptance (mock Cordis context, real HTTP handlers)
 *   4. browser bundle static + fake-loader checks
 *   5. browser bundle render scenarios on the fake DOM/React harness
 *
 * Exit code 0 = every step passed.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const node = process.execPath;

const steps = [
  { label: "syntax: index.js", args: ["--check", path.join(root, "index.js")] },
  { label: "syntax: lib/client.js", args: ["--check", path.join(root, "lib/client.js")] },
  { label: "host: black-box acceptance", args: [path.join(here, "check-host.mjs")] },
  { label: "client: static + fake loader", args: [path.join(here, "check-client.mjs")] },
  { label: "client: render scenarios", args: [path.join(here, "render.mjs")] },
];

let failed = 0;
for (const step of steps) {
  process.stdout.write(`\n=== ${step.label} ===\n`);
  const result = spawnSync(node, step.args, { cwd: root, stdio: "inherit" });
  if (result.error !== undefined) {
    console.error(`could not run "${step.label}": ${result.error.message}`);
    failed += 1;
    continue;
  }
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAILED: ${step.label} (exit ${String(result.status)})`);
  }
}

if (failed > 0) {
  console.error(`\ntest/run.mjs: ${failed} step(s) failed`);
  process.exit(1);
}
console.log("\ntest/run.mjs: all steps passed");
