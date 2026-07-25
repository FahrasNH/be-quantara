#!/usr/bin/env node
"use strict";

/**
 * Clear stuck backtest queue on DATASET_EXPAND_API_URL (dev/staging).
 *
 *   node scripts/backtest-clear-queue.js           # cancel my jobs
 *   node scripts/backtest-clear-queue.js --all     # SUPER_ADMIN: cancel everyone
 *   node scripts/backtest-clear-queue.js --list    # list only
 */

require("dotenv").config();
const path = require("path");

async function main() {
  const apiBase = process.env.DATASET_EXPAND_API_URL;
  const email = process.env.DATASET_EXPAND_EMAIL;
  const password = process.env.DATASET_EXPAND_PASSWORD;
  if (!apiBase || !email || !password) {
    console.error("Need DATASET_EXPAND_API_URL + EMAIL + PASSWORD in .env");
    process.exit(1);
  }

  const { loginForToken, apiFetch } = (() => {
    const mod = require("./dataset-expand/lib/viaApi");
    return mod;
  })();

  // apiFetch may not be exported — inline
  async function fetchJson(baseUrl, token, p, { method = "GET", body } = {}) {
    const url = `${baseUrl.replace(/\/$/, "")}${p}`;
    const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
    if (body != null) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || data.message || `HTTP ${res.status}`);
    }
    return data;
  }

  const listOnly = process.argv.includes("--list");
  const all = process.argv.includes("--all");

  console.log(`[clear-queue] login → ${apiBase}`);
  const token = await loginForToken({ apiBase, email, password });

  const before = await fetchJson(apiBase, token, "/api/v1/health");
  console.log("[clear-queue] health.backtest:", before.backtest);

  try {
    const listed = await fetchJson(apiBase, token, "/api/v1/backtest/queue");
    console.log("[clear-queue] my active jobs:", listed.jobs || listed);
  } catch (err) {
    console.warn(`[clear-queue] GET /queue not available yet (${err.message}) — deploy BE first`);
  }

  if (listOnly) return;

  try {
    const q = all ? "?all=1" : "";
    const result = await fetchJson(apiBase, token, `/api/v1/backtest/queue${q}`, { method: "DELETE" });
    console.log("[clear-queue] cancelled:", result);
  } catch (err) {
    console.error(`[clear-queue] DELETE /queue failed: ${err.message}`);
    console.error("Fallback: SSH and run  pm2 reload be-quantara-dev");
    process.exit(1);
  }

  const after = await fetchJson(apiBase, token, "/api/v1/health");
  console.log("[clear-queue] health.backtest after:", after.backtest);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
