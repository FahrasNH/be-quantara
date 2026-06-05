// Persistensi log bot ke PostgreSQL (Prisma BotLog)

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

/**
 * Simpan satu entri log ke DB (fire-and-forget dari BotEngine).
 */
async function persistBotLog({ botId, level, message, metadata = null }) {
  if (!botId || !level || !message) return;

  await prisma.botLog.create({
    data: {
      botId,
      level,
      message: String(message).slice(0, 4000),
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
  });
}

/**
 * Ambil log gabungan semua bot milik user, kronologis (terbaru di akhir).
 */
async function getUserBotLogs(userId, limit = 800) {
  const take = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);

  const bots = await prisma.bot.findMany({
    where:  { userId },
    select: { id: true, symbol: true },
  });

  if (bots.length === 0) return [];

  const symbolByBotId = Object.fromEntries(bots.map(b => [b.id, b.symbol]));

  const rows = await prisma.botLog.findMany({
    where:   { botId: { in: bots.map(b => b.id) } },
    orderBy: { createdAt: "desc" },
    take,
  });

  return rows
    .reverse()
    .map(row => ({
      time:   row.createdAt,
      level:  row.level,
      msg:    row.message,
      symbol: symbolByBotId[row.botId],
    }));
}

module.exports = { persistBotLog, getUserBotLogs };
