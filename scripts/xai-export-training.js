#!/usr/bin/env node
/**
 * Export dataset training dari trade history (JSONL) — siap untuk xAI Collection / ML.
 *
 * Usage:
 *   node scripts/xai-export-training.js [--userId=UUID] [--symbol=BTCUSDT] [--limit=500]
 *
 * Output: stdout JSONL atau file jika --out=path
 */

require("dotenv").config();
const fs = require("fs");
const db = require("../src/infrastructure/db/database");
const XaiTrainingService = require("../src/server/services/XaiTrainingService");

function parseArgs() {
  const args = { limit: 500 };
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, "").split("=");
    if (k === "userId") args.userId = v;
    else if (k === "symbol") args.symbol = v;
    else if (k === "limit") args.limit = parseInt(v, 10);
    else if (k === "out") args.out = v;
    else if (k === "upload") args.upload = v !== "false";
  }
  return args;
}

async function main() {
  const args = parseArgs();

  if (!args.userId) {
    console.error("❌ --userId=<uuid> diperlukan (atau modifikasi script untuk export global)");
    process.exit(1);
  }

  await db.init?.().catch(() => {});

  const dataset = await XaiTrainingService.exportTrainingDataset(args.userId, {
    symbol: args.symbol ?? null,
    limit: args.limit,
  });

  console.error(`📊 Exported ${dataset.count} records`);

  if (args.out) {
    fs.writeFileSync(args.out, dataset.jsonl, "utf8");
    console.error(`💾 Saved to ${args.out}`);
  } else {
    process.stdout.write(dataset.jsonl);
  }

  if (args.upload && process.env.XAI_COLLECTION_ID) {
    const result = await XaiTrainingService.uploadTrainingSnapshot(args.userId, {
      symbol: args.symbol,
      limit: args.limit,
    });
    console.error("☁️  Uploaded to xAI:", JSON.stringify(result));
  }
}

main().catch(err => {
  console.error("❌ Gagal:", err.message);
  process.exit(1);
});
