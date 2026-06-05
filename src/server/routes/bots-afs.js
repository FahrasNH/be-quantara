
  /**
   * GET /api/v1/account/balance
   * Get total account balance across all bots
   */
  router.get("/account/balance", async (req, res) => {
    try {
      let totalBalance = 0;
      const bots = Object.values(botsMap);

      for (const bot of bots) {
        if (bot.config.dryRun) {
          totalBalance += bot.state?.capital || 0;
        } else {
          try {
            const balance = await bot.client.getBalance(bot.config.marginCoin);
            totalBalance += balance?.balance || 0;
          } catch (err) {
            console.error(`Failed to get balance for ${bot.config.symbol}:`, err.message);
          }
        }
      }

      res.json({
        ok: true,
        balance: totalBalance,
        currency: "USDT",
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/v1/account/keys
   * Get masked API keys from environment
   */
  router.get("/account/keys", (req, res) => {
    try {
      const apiKey = process.env.BINANCE_API_KEY;
      const apiSecret = process.env.BINANCE_API_SECRET;

      res.json({
        ok: true,
        apiKey: apiKey ? apiKey : null,
        apiSecret: apiSecret ? apiSecret : null,
        configured: !!(apiKey && apiSecret),
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
};
