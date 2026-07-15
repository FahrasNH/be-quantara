#!/usr/bin/env node
/**
 * Glob-based test runner — discovers and runs all test/*.test.js (plus run-strategies.js).
 * - Files using `node:test` → `node --test <file>`
 * - Other plain node scripts → `node <file>`
 * Does not halt on first failure; reports pass/fail per file.
 */

"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TEST_DIR = path.join(ROOT, "test");

const grepArg = process.argv.find((a, i) => process.argv[i - 1] === "--grep");
const filter = grepArg ? String(grepArg).toLowerCase() : null;

const entries = fs
  .readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".test.js") || f === "run-strategies.js")
  .filter((f) => (filter ? f.toLowerCase().includes(filter) : true))
  .sort();

if (entries.length === 0) {
  console.error("No test files found" + (filter ? ` matching --grep ${filter}` : ""));
  process.exit(1);
}

const results = [];
let failed = 0;

console.log(`\n🧪 Running ${entries.length} test file(s)…\n`);

for (const file of entries) {
  const full = path.join(TEST_DIR, file);
  const src = fs.readFileSync(full, "utf8");
  const useNodeTest = /require\(['"]node:test['"]\)/.test(src) || /from ['"]node:test['"]/.test(src);
  const args = useNodeTest ? ["--test", full] : [full];
  const started = Date.now();
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "test" },
    timeout: 180_000,
  });
  const ms = Date.now() - started;
  const ok = res.status === 0;
  if (!ok) failed += 1;
  results.push({ file, ok, ms, status: res.status, signal: res.signal });

  const mark = ok ? "✓" : "✗";
  console.log(`${mark} ${file} (${ms}ms)`);
  if (!ok) {
    const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
    if (out) {
      const lines = out.split("\n").slice(-40);
      console.log(lines.map((l) => `    ${l}`).join("\n"));
    }
    if (res.signal) console.log(`    killed by signal ${res.signal}`);
  }
}

console.log(`\n── Summary: ${results.length - failed} passed, ${failed} failed (of ${results.length}) ──\n`);
process.exit(failed > 0 ? 1 : 0);
