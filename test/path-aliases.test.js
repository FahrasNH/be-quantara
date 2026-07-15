/**
 * Phase 1 — verify Node package imports (#core/#shared/#infra/#config) resolve,
 * including from a child_process.fork (backtest worker pattern).
 */

"use strict";

const assert = require("assert");
const { fork } = require("child_process");
const path = require("path");

console.log("\n🧭 path-aliases Unit Tests\n");

const logger = require("#shared/logger");
assert.ok(logger && typeof logger.info === "function", "logger.info available");
assert.ok(typeof logger.child === "function", "logger.child available");

const env = require("#config/env.js");
assert.ok(env && typeof env.validate === "function", "config/env via #config");

const prismaPath = require.resolve("#infra/db/prismaClient.js");
assert.ok(prismaPath.includes("infrastructure"), "#infra maps to infrastructure/");

console.log("  ✓ parent process resolves #shared/#config/#infra");

const childScript = path.join(__dirname, "fixtures", "alias-fork-child.js");
const child = fork(childScript, [], {
  cwd: path.join(__dirname, ".."),
  silent: true,
});

let got = null;
child.on("message", (msg) => {
  got = msg;
});

child.on("exit", (code) => {
  assert.strictEqual(code, 0, `fork child exit code ${code}`);
  assert.deepStrictEqual(got, { ok: true }, "fork child reported ok");
  console.log("  ✓ forked child resolves #shared/#config");
  console.log("\n✅ path-aliases tests passed\n");
});
