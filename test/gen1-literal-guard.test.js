/**
 * Guardrail: deprecated strategy abbrev literals MUST NOT appear outside the ACL module.
 * Run: node test/gen1-literal-guard.test.js
 */
const fs = require("fs");
const path = require("path");
const { DEPRECATED_STRATEGY_ABBREVS, GEN1_STRATEGY_LITERALS } = require("../src/config/strategyKeyNormalizer");

const SRC_ROOT = path.join(__dirname, "../src");
const ACL_FILE = "config/strategyKeyNormalizer.js";

/** Gen1 short abbrevs + deprecated Gen2 component abbrevs. */
const FORBIDDEN_PATTERNS = [
  ...DEPRECATED_STRATEGY_ABBREVS.map((k) => new RegExp(`\\b${k}\\b`)),
  ...GEN1_STRATEGY_LITERALS.flatMap((k) => [
    new RegExp(`\\b"${k}"\\b`),
    new RegExp(`\\b'${k}'\\b`),
  ]),
];

/** Documented exceptions: implementation class names / historical test fixtures. */
const ALLOWLIST = new Set([
  path.join(SRC_ROOT, "core/strategy-engine/implementations/SmartMoneyConceptsStrategy.js"),
  path.join(SRC_ROOT, "core/strategy-engine/implementations/TrendFollowingStrategy.js"),
  path.join(SRC_ROOT, "core/strategy-engine/implementations/MeanReversionStrategy.js"),
  path.join(SRC_ROOT, "core/strategy-engine/implementations/BreakoutTradingStrategy.js"),
]);

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, acc);
    else if (ent.name.endsWith(".js")) acc.push(full);
  }
  return acc;
}

console.log("\n═══ Deprecated strategy abbrev guardrail ═══\n");

const violations = [];
for (const file of walk(SRC_ROOT)) {
  if (file.endsWith(ACL_FILE) || file.includes(`${path.sep}config${path.sep}strategyKeyNormalizer.js`)) {
    continue;
  }
  if (ALLOWLIST.has(file)) continue;

  const content = fs.readFileSync(file, "utf8");
  const rel = path.relative(path.join(__dirname, ".."), file);
  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(content)) {
      violations.push({ file: rel, pattern: pat.source });
      break;
    }
  }
}

if (violations.length > 0) {
  console.error("Deprecated abbrev literals found outside ACL module:\n");
  for (const v of violations) {
    console.error(`  ${v.file}  (matched ${v.pattern})`);
  }
  process.exit(1);
}

console.log(`  ✓ Scanned ${walk(SRC_ROOT).length} files — zero deprecated abbrevs outside ACL`);
console.log("\nAll gen1-literal-guard tests passed.\n");
