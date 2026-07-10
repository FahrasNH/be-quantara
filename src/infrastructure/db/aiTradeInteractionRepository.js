// Persistensi interaksi Grok AI ke PostgreSQL (Prisma AiTradeInteraction)

const prisma = require("./prismaClient");

/**
 * Simpan satu interaksi Grok (fire-and-forget).
 * @param {{ userId: string, botId?: string|null, symbol: string, type: string, prompt: string, response: string, parsed?: object|null }} opts
 */
async function persistAiTradeInteraction(opts) {
  const { userId, botId, symbol, type, prompt, response, parsed } = opts;
  if (!userId || !symbol || !type) return;

  await prisma.aiTradeInteraction.create({
    data: {
      userId,
      botId: botId ?? null,
      symbol,
      type,
      prompt: String(prompt || "").slice(0, 50_000),
      response: String(response || "").slice(0, 50_000),
      parsed: parsed ?? undefined,
    },
  });
}

module.exports = { persistAiTradeInteraction };
