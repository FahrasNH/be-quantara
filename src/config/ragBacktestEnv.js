"use strict";

/**
 * RAG backtest engines are staging-only but staging PM2 runs NODE_ENV=production.
 * Use explicit signals (APP_ENV, PORT, DB name, RAG_BACKTEST_ENABLED) so the
 * dashboard works on be-quantara-staging without opening prod port 3000.
 */
function isRagBacktestAllowed() {
  if (process.env.RAG_BACKTEST_ENABLED === "true") return true;
  if (process.env.NODE_ENV !== "production") return true;
  if (process.env.APP_ENV === "staging" || process.env.APP_ENV === "test") return true;
  if (String(process.env.PORT || "") === "3001") return true;

  const pm2Name = process.env.name || process.env.pm2_name || "";
  if (/staging/i.test(pm2Name)) return true;

  const dbUrl = process.env.DATABASE_URL || "";
  const dbName = dbUrl.match(/\/([^/?]+)(\?|$)/)?.[1] || "";
  if (/staging|dev|test/i.test(dbName)) return true;

  return false;
}

module.exports = { isRagBacktestAllowed };
