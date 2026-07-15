// ── src/services/exchangeKeyPurge.js ────────────────────────────────────────
// Cron-style purger for soft-deleted UserExchange records.
//
// Soft-deleted records (deletedAt != null) are retained for 7 days for audit
// purposes, then permanently removed by this job. The job runs every 6 hours
// inside the Node.js process — no external cron required.

// PrismaClient bersama (satu instance untuk seluruh proses) — lihat prismaClient.js
const prisma = require("../../../infrastructure/db/prismaClient");

/**
 * Deletes UserExchange records that were soft-deleted more than 7 days ago.
 * Safe to call at any time; errors are caught and logged (non-fatal).
 */
async function purgeExpiredExchangeKeys() {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const result = await prisma.userExchange.deleteMany({
      where: {
        deletedAt: { lt: cutoff },
      },
    });

    if (result.count > 0) {
      console.log(`[ExchangeKeyPurge] Deleted ${result.count} expired soft-deleted UserExchange record(s) (older than 7 days).`);
    }
  } catch (err) {
    console.error("[ExchangeKeyPurge] Error during purge:", err.message);
  }
}

/**
 * Schedules purgeExpiredExchangeKeys() to run every 6 hours.
 * Call once at server startup.
 */
function scheduleKeyPurge() {
  const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

  // Run once at startup (after a short delay to avoid blocking boot)
  setTimeout(purgeExpiredExchangeKeys, 30_000);

  // Then repeat every 6 hours
  setInterval(purgeExpiredExchangeKeys, INTERVAL_MS);

  console.log("[ExchangeKeyPurge] Scheduled — runs every 6h, first run in 30s.");
}

module.exports = {
  purgeExpiredExchangeKeys,
  scheduleKeyPurge,
};
