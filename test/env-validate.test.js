// test/env-validate.test.js — DB name guard must not block bot_trading_development
const { test } = require("node:test");
const assert = require("node:assert/strict");

function loadEnvModule() {
  delete require.cache[require.resolve("../src/config/env")];
  return require("../src/config/env");
}

test("isNonProductionDbName: bot_trading_development is allowed", () => {
  const cfg = loadEnvModule();
  assert.equal(cfg.isNonProductionDbName("bot_trading_development"), false);
});

test("isNonProductionDbName: bot_trading_staging is flagged", () => {
  const cfg = loadEnvModule();
  assert.equal(cfg.isNonProductionDbName("bot_trading_staging"), true);
});

test("validate: NODE_ENV=production + bot_trading_development does not fail on db name", () => {
  const prev = { ...process.env };
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:5432/bot_trading_development?schema=public";
  process.env.JWT_SECRET = "a".repeat(48);
  process.env.JWT_REFRESH_SECRET = "b".repeat(48);
  process.env.ENCRYPTION_KEY = "c".repeat(64);
  process.env.ADMIN_SECRET = "d".repeat(24);

  const cfg = loadEnvModule();
  assert.doesNotThrow(() => cfg.validate());

  process.env = prev;
  delete require.cache[require.resolve("../src/config/env")];
});

test("validate: NODE_ENV=production + bot_trading_staging fails without ALLOW_DB_ENV_MISMATCH", () => {
  const prev = { ...process.env };
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:5432/bot_trading_staging?schema=public";
  process.env.JWT_SECRET = "a".repeat(48);
  process.env.JWT_REFRESH_SECRET = "b".repeat(48);
  process.env.ENCRYPTION_KEY = "c".repeat(64);
  process.env.ADMIN_SECRET = "d".repeat(24);
  delete process.env.ALLOW_DB_ENV_MISMATCH;

  const cfg = loadEnvModule();
  assert.throws(() => cfg.validate(), /bot_trading_staging/);

  process.env = prev;
  delete require.cache[require.resolve("../src/config/env")];
});
