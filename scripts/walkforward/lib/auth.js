"use strict";

const { loginForToken } = require("../../dataset-expand/lib/viaApi");

function hasViaApiAuth(env = process.env) {
  return Boolean(
    (env.DATASET_EXPAND_EMAIL && env.DATASET_EXPAND_PASSWORD)
    || env.DATASET_EXPAND_TOKEN,
  );
}

function requireViaApiCredentials({ dryRun, useLocal, api }) {
  if (dryRun || useLocal) return;
  if (!api || !hasViaApiAuth()) {
    console.error("\n❌ Missing dev server credentials.");
    console.error("Set in be-bot-trading/.env:");
    console.error("  DATASET_EXPAND_API_URL=https://dev.quantara.software");
    console.error("  DATASET_EXPAND_EMAIL + DATASET_EXPAND_PASSWORD");
    console.error("\nOr run with --local or --dry-run.");
    process.exit(1);
  }
}

async function resolveViaApiToken({ dryRun, useLocal, api, log = console.log }) {
  if (dryRun || useLocal) return null;
  let token = process.env.DATASET_EXPAND_TOKEN || null;
  if (!token && process.env.DATASET_EXPAND_EMAIL) {
    log(`[auth] Single login → ${api}`);
    token = await loginForToken({
      apiBase: api,
      email: process.env.DATASET_EXPAND_EMAIL,
      password: process.env.DATASET_EXPAND_PASSWORD,
      log,
    });
  }
  return token;
}

module.exports = {
  hasViaApiAuth,
  requireViaApiCredentials,
  resolveViaApiToken,
};
