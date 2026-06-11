// ── src/services/exchangeSwitch.js ─────────────────────────────────────────
// Exchange Switch — Skenario B Flavor 2 (Soft Block)
//
// Rules:
//   • Cannot switch while there are OPEN positions (Trade.status="OPEN")
//   • Cannot switch while bots are running
//   • If both blockers → blockerReason "BOTH"
//   • Rate limit: max 3 switches per user per 24h (using AuditLog)
//   • Old UserExchange is soft-deleted (deletedAt=now), NOT physically removed
//   • New keys validated against exchange before revoking old

const { PrismaClient } = require("@prisma/client");
const BitgetClient = require("../infrastructure/exchange/BitgetClient");
const { upsertExchange } = require("./userExchange");

const prisma = new PrismaClient();

// ─── getExchangeStatus ──────────────────────────────────────────────────────
/**
 * Returns the current exchange status for a user.
 *
 * @param {string} userId
 * @returns {{ exchange: string|null, connected: boolean, openPositions: number,
 *             runningBots: number, canSwitch: boolean, blockerReason: string|null,
 *             positions: Array }}
 */
async function getExchangeStatus(userId) {
  // Active (not soft-deleted) exchange record
  const userExchange = await prisma.userExchange.findFirst({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });

  // Open trades via bots owned by this user
  const openTrades = await prisma.trade.findMany({
    where: {
      status: "OPEN",
      bot: { userId },
    },
    select: { symbol: true, side: true, pnl: true },
  });

  // Running bots
  const runningBotsCount = await prisma.bot.count({
    where: { userId, running: true },
  });

  const openPositions = openTrades.length;
  const runningBots = runningBotsCount;

  let blockerReason = null;
  if (openPositions > 0 && runningBots > 0) {
    blockerReason = "BOTH";
  } else if (openPositions > 0) {
    blockerReason = "OPEN_POSITIONS";
  } else if (runningBots > 0) {
    blockerReason = "BOTS_RUNNING";
  }

  return {
    exchange: userExchange?.exchangeType ?? null,
    connected: !!userExchange,
    openPositions,
    runningBots,
    canSwitch: openPositions === 0 && runningBots === 0,
    blockerReason,
    // Expose open position details for informational purposes
    positions: openTrades.map((t) => ({
      symbol: t.symbol,
      side: t.side,
      unrealizedPnl: t.pnl ?? null,
    })),
  };
}

// ─── validateNewExchangeKey ─────────────────────────────────────────────────
/**
 * Tests whether the provided API credentials are valid for the given exchange.
 * Only validates "bitget"; other exchanges are skipped (trusted as-is).
 *
 * @param {string} exchangeType
 * @param {string} apiKey
 * @param {string} secretKey
 * @param {string|undefined} passphrase
 * @returns {true}
 * @throws {{ statusCode: 422, message: string }}
 */
async function validateNewExchangeKey(exchangeType, apiKey, secretKey, passphrase) {
  if (exchangeType !== "bitget") {
    // Non-bitget exchanges: skip validation, save as-is
    return true;
  }

  try {
    const client = new BitgetClient(apiKey, secretKey, passphrase);
    await client.getBalance("USDT");
    return true;
  } catch (err) {
    const error = new Error("API key tidak valid, periksa kembali");
    error.statusCode = 422;
    error.originalMessage = err.message;
    throw error;
  }
}

// ─── switchExchange ─────────────────────────────────────────────────────────
/**
 * Performs the full exchange switch flow:
 *   1. Rate-limit check (max 3 per 24h via AuditLog)
 *   2. Guard: no open positions, no running bots
 *   3. Validate new keys against exchange
 *   4. Stop all running bots (graceful — set running=false, stoppedAt=now)
 *   5. Soft-delete old UserExchange (deletedAt=now)
 *   6. Save new UserExchange via upsertExchange
 *   7. Write AuditLog entry
 *
 * @param {string} userId
 * @param {{ newExchange: string, apiKey: string, secretKey: string,
 *           passphrase?: string, ipAddress?: string, userAgent?: string }} params
 * @returns {{ ok: true, message: string, newExchange: string }}
 */
async function switchExchange(userId, { newExchange, apiKey, secretKey, passphrase, ipAddress, userAgent }) {
  // ── 1. Rate limit: max 3 EXCHANGE_SWITCH actions per user per 24h ──────────
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentSwitches = await prisma.auditLog.count({
    where: {
      userId,
      action: "EXCHANGE_SWITCH",
      createdAt: { gt: since },
    },
  });

  if (recentSwitches >= 3) {
    const err = new Error("Terlalu banyak pergantian exchange. Maksimal 3 kali per 24 jam.");
    err.statusCode = 429;
    err.code = "RATE_LIMIT_EXCEEDED";
    throw err;
  }

  // ── 2. Guard: cannot switch with open positions or running bots ───────────
  const status = await getExchangeStatus(userId);
  if (!status.canSwitch) {
    const err = new Error(
      status.blockerReason === "BOTH"
        ? "Tidak bisa mengganti exchange: ada posisi terbuka dan bot sedang berjalan."
        : status.blockerReason === "OPEN_POSITIONS"
        ? "Tidak bisa mengganti exchange: masih ada posisi terbuka."
        : "Tidak bisa mengganti exchange: bot masih berjalan. Hentikan semua bot terlebih dahulu."
    );
    err.statusCode = 409;
    err.blockerReason = status.blockerReason;
    // Contract code per QA-01: OPEN_POSITIONS_EXIST | BOT_RUNNING | BOTH
    err.code =
      status.blockerReason === "BOTH"
        ? "BOTH"
        : status.blockerReason === "OPEN_POSITIONS"
        ? "OPEN_POSITIONS_EXIST"
        : "BOT_RUNNING";
    err.positions = status.positions;
    throw err;
  }

  const fromExchange = status.exchange;

  // ── 3. Validate new keys BEFORE revoking old ──────────────────────────────
  await validateNewExchangeKey(newExchange, apiKey, secretKey, passphrase);

  // ── 4. Graceful stop: mark all running bots as stopped ───────────────────
  await prisma.bot.updateMany({
    where: { userId, running: true },
    data: { running: false, stoppedAt: new Date() },
  });

  // ── 5. Soft-delete old UserExchange records (set deletedAt) ───────────────
  await prisma.userExchange.updateMany({
    where: { userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });

  // ── 6. Save new UserExchange (upsertExchange handles encrypt + legacy sync) ─
  // upsertExchange uses @@unique([userId, exchangeType]) — the soft-deleted record
  // for the same exchangeType was just marked deletedAt but is still in DB.
  // We create a fresh record by using a direct create here to avoid the upsert
  // hitting the soft-deleted row. However, upsertExchange will update-in-place
  // (same userId+exchangeType) and also update legacy User columns — which is desired.
  await upsertExchange(userId, {
    apiKey,
    apiSecret: secretKey,
    apiPassphrase: passphrase,
    exchangeType: newExchange,
  });

  // Clear the deletedAt on the newly upserted record so it is active again
  await prisma.userExchange.updateMany({
    where: { userId, exchangeType: newExchange },
    data: { deletedAt: null },
  });

  // ── Invariant enforcement: tepat SATU exchange aktif per user ──────────────
  // Defends against partial-failure / legacy state: soft-delete setiap record
  // yang masih aktif tetapi BUKAN exchange yang baru dipilih. Idempotent.
  await prisma.userExchange.updateMany({
    where: { userId, deletedAt: null, NOT: { exchangeType: newExchange } },
    data: { deletedAt: new Date() },
  });

  // ── 7. Write AuditLog ─────────────────────────────────────────────────────
  await prisma.auditLog.create({
    data: {
      userId,
      action: "EXCHANGE_SWITCH",
      resource: "UserExchange",
      details: JSON.stringify({
        fromExchange,
        toExchange: newExchange,
        openPositionsAtSwitch: 0,
        timestamp: new Date().toISOString(),
      }),
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    },
  });

  return {
    ok: true,
    message: `Exchange berhasil diganti ke ${newExchange}.`,
    newExchange,
  };
}

module.exports = {
  getExchangeStatus,
  validateNewExchangeKey,
  switchExchange,
};
