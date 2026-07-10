#!/usr/bin/env node
/**
 * Sync dokumentasi strategi Quantara ke xAI Collection (console.x.ai).
 *
 * Usage:
 *   XAI_ENABLED=true XAI_API_KEY=... XAI_MANAGEMENT_API_KEY=... XAI_COLLECTION_ID=... \
 *     node scripts/xai-sync-knowledge.js
 */

require("dotenv").config();
const XaiTrainingService = require("../src/server/services/XaiTrainingService");

async function main() {
  console.log("🔄 Sync knowledge base ke xAI Collection…");
  const status = XaiTrainingService.getStatus();
  console.log("Status:", JSON.stringify(status, null, 2));

  if (!status.enabled) {
    console.error("❌ XAI_ENABLED=true dan XAI_API_KEY harus diset di .env");
    process.exit(1);
  }
  if (!status.collection_configured) {
    console.error("❌ XAI_COLLECTION_ID dan XAI_MANAGEMENT_API_KEY diperlukan");
    process.exit(1);
  }

  const result = await XaiTrainingService.syncKnowledgeBase({ includeStrategyDefaults: true });
  console.log("✅ Sync selesai:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error("❌ Gagal:", err.message);
  process.exit(1);
});
