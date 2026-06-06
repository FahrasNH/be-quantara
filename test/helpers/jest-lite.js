/**
 * jest-lite.js — Zero-dependency test runner shim
 *
 * Provides a minimal subset of the Jest API (describe / test / it / beforeEach /
 * expect) so strategy test files can run under plain `node` without installing
 * Jest or Mocha. Keeps the project dependency-free (consistent with the existing
 * hand-rolled test/indicators.test.js runner) while preserving the readable
 * describe/expect test style.
 *
 * Usage in a test file:
 *   const { describe, test, expect, beforeEach, run } = require("./helpers/jest-lite");
 *   describe("suite", () => { test("case", () => { expect(1).toBe(1); }); });
 *   run();   // executes registered suites, prints summary, sets exit code
 *
 * Or run many files via test/run-strategies.js which registers then runs once.
 */

// ── Registry ────────────────────────────────────────────────────────────────
const rootSuites = [];
let currentSuite = null;

function describe(name, fn) {
  const parent = currentSuite;
  const suite = { name, tests: [], beforeEach: [], children: [], parent };
  if (parent) parent.children.push(suite);
  else rootSuites.push(suite);
  currentSuite = suite;
  fn();
  currentSuite = parent;
}

function test(name, fn) {
  if (!currentSuite) {
    // Allow top-level tests by wrapping in an implicit root suite
    const suite = { name: "(root)", tests: [], beforeEach: [], children: [], parent: null };
    rootSuites.push(suite);
    currentSuite = suite;
  }
  currentSuite.tests.push({ name, fn });
}

function beforeEach(fn) {
  if (!currentSuite) throw new Error("beforeEach must be inside a describe()");
  currentSuite.beforeEach.push(fn);
}

// ── Matchers ────────────────────────────────────────────────────────────────
function fail(msg) {
  throw new Error(msg);
}

function fmt(v) {
  if (typeof v === "string") return `"${v}"`;
  if (Array.isArray(v)) return `[${v.length} items]`;
  return String(v);
}

function buildMatchers(received, negated = false) {
  const ok = (pass, msg) => {
    if (negated ? pass : !pass) {
      fail(`${negated ? "[not] " : ""}${msg}`);
    }
  };

  const m = {
    toBe: (exp) => ok(Object.is(received, exp), `expected ${fmt(received)} to be ${fmt(exp)}`),
    toEqual: (exp) =>
      ok(JSON.stringify(received) === JSON.stringify(exp),
        `expected ${fmt(received)} to equal ${fmt(exp)}`),
    toBeNull: () => ok(received === null, `expected ${fmt(received)} to be null`),
    toBeDefined: () => ok(received !== undefined, `expected value to be defined`),
    toBeTruthy: () => ok(!!received, `expected ${fmt(received)} to be truthy`),
    toBeFalsy: () => ok(!received, `expected ${fmt(received)} to be falsy`),
    toBeGreaterThan: (exp) => ok(received > exp, `expected ${fmt(received)} > ${fmt(exp)}`),
    toBeGreaterThanOrEqual: (exp) => ok(received >= exp, `expected ${fmt(received)} >= ${fmt(exp)}`),
    toBeLessThan: (exp) => ok(received < exp, `expected ${fmt(received)} < ${fmt(exp)}`),
    toBeLessThanOrEqual: (exp) => ok(received <= exp, `expected ${fmt(received)} <= ${fmt(exp)}`),
    toBeCloseTo: (exp, digits = 2) => {
      const tol = Math.pow(10, -digits) / 2;
      ok(Math.abs(received - exp) < tol, `expected ${fmt(received)} close to ${fmt(exp)} (±${tol})`);
    },
    toContain: (exp) =>
      ok(received != null && received.includes(exp),
        `expected ${fmt(received)} to contain ${fmt(exp)}`),
    toHaveLength: (exp) =>
      ok(received != null && received.length === exp,
        `expected length ${received != null ? received.length : "n/a"} to be ${exp}`),
  };

  return m;
}

function expect(received) {
  const matchers = buildMatchers(received, false);
  matchers.not = buildMatchers(received, true);
  return matchers;
}

// ── Runner ──────────────────────────────────────────────────────────────────
function collectBeforeEach(suite) {
  const chain = [];
  let s = suite;
  const stack = [];
  while (s) { stack.unshift(s); s = s.parent; }
  for (const node of stack) chain.push(...node.beforeEach);
  return chain;
}

function runSuite(suite, prefix, stats) {
  const heading = prefix ? `${prefix} › ${suite.name}` : suite.name;

  for (const t of suite.tests) {
    const hooks = collectBeforeEach(suite);
    try {
      for (const h of hooks) h();
      t.fn();
      stats.passed++;
      // Keep output quiet on pass; uncomment for verbose:
      // console.log(`  ✓ ${heading} › ${t.name}`);
    } catch (err) {
      stats.failed++;
      stats.failures.push({ name: `${heading} › ${t.name}`, message: err.message });
      console.log(`  ✗ ${heading} › ${t.name}`);
      console.log(`      ${err.message}`);
    }
  }

  for (const child of suite.children) {
    runSuite(child, heading, stats);
  }
}

function run(label = "Strategy Tests") {
  const stats = { passed: 0, failed: 0, failures: [] };

  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║   ${label.padEnd(36)} ║`);
  console.log(`╚════════════════════════════════════════╝\n`);

  for (const suite of rootSuites) {
    runSuite(suite, "", stats);
  }

  const total = stats.passed + stats.failed;
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  TESTS: ${stats.passed} passed, ${stats.failed} failed (${total} total)`);
  console.log(stats.failed === 0 ? `\n  ✅ ALL TESTS PASSED\n` : `\n  ❌ ${stats.failed} TEST(S) FAILED\n`);

  // Clear registry so multiple run() calls don't double-count
  rootSuites.length = 0;
  currentSuite = null;

  if (stats.failed > 0) process.exitCode = 1;
  return stats;
}

module.exports = { describe, test, it: test, beforeEach, expect, run };
