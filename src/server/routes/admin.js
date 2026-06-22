// ─── src/server/routes/admin.js ─────────────────────────────────────────────
// Admin-only endpoints for manual tier management.
// BILLING STUB — replaces payment gateway until billing system is built.
// Protect this router with an admin secret header check, not just authMiddleware.

module.exports = function createAdminRouter(helpers = {}) {
  const express    = require("express");
  const router     = express.Router();
  const { asyncHandler }  = require("../../middleware/errorHandler");
  const { TIER_ORDER, TIER_CONFIG } = require("../../domain/tierConfig");
  const cfg = require("../../config/env");
  const { authMiddleware }              = require("../../middleware/auth");
  const { adminGuard, superAdminGuard } = require("../../middleware/adminGuard");
  const bcrypt    = require("bcryptjs");

  // PrismaClient bersama (satu instance untuk seluruh proses) — lihat prismaClient.js
  const prisma = require("../../infrastructure/db/prismaClient");
  // Real trade store (engine writes here via insertTrade). The Prisma `Trade`
  // model is unused/empty, so trade-derived admin data must read from this layer.
  const db = require("../../infrastructure/db/database");
  // File-backed platform state (maintenance/flags + flagged users) — no Prisma
  // model needed. See platformStore.js.
  const platformStore = require("../../infrastructure/store/platformStore");
  // Best-effort Telegram notifier for the emergency Stop-All broadcast.
  const telegram = require("../../infrastructure/notifications/TelegramNotifier");

  // Injected from app.js — halts every in-memory BotEngine (Stop-All).
  const { stopAllBotsInMemory } = helpers;

  // JWT + role-based protection for the Admin Dashboard endpoints (ADMIN-BE-02/03).
  const requireAdmin      = [authMiddleware, adminGuard];      // any admin
  const requireSuperAdmin = [authMiddleware, superAdminGuard]; // SUPER_ADMIN only

  const MANAGEABLE_ROLES = ["ADMIN", "SUPER_ADMIN"];
  const ALL_ROLES        = ["USER", "ADMIN", "SUPER_ADMIN"];

  // AuditLog every admin mutation (BE-03 AC-06). Never let logging break the action.
  async function audit(req, action, resource, resourceId, details) {
    try {
      await prisma.auditLog.create({
        data: {
          userId:     req.adminUser.id,
          action,
          resource,
          resourceId,
          details:    details ? JSON.stringify(details) : null,
          ipAddress:  req.ip || null,
          userAgent:  req.headers["user-agent"] || null,
        },
      });
    } catch (_e) { /* swallow — audit is best-effort */ }
  }

  // ── Display helpers ─────────────────────────────────────────────────────────
  const STRATEGY_ABBREV = {
    ADAPTIVE_FUSION: "AF",
    TREND_MOMENTUM:  "TM",
    MEAN_REVERSION:  "MR",
    BREAKOUT_RETEST: "BR",
  };
  const abbrevStrategy = key => STRATEGY_ABBREV[key] || (key ? key.slice(0, 2).toUpperCase() : "—");

  const EXCHANGE_LABEL = { bitget: "Bitget", okx: "OKX", binance: "Binance" };
  const exchangeLabel = ex => EXCHANGE_LABEL[ex] || (ex ? ex.charAt(0).toUpperCase() + ex.slice(1) : "—");

  // "DD/MM HH:mm" — matches the admin dashboard mockup's compact timestamps.
  const fmtShort = d => {
    if (!d) return "—";
    const dt = new Date(d);
    const p = n => String(n).padStart(2, "0");
    return `${p(dt.getDate())}/${p(dt.getMonth() + 1)} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
  };

  const csvCell = v => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  // SECURITY: masked fingerprint for API keys — never the raw key/secret
  // (ADMIN-FE-07 AC-02). Lives in a shared util so it can be unit-tested.
  const { maskKey } = require("../../infrastructure/security/maskKey");

  // Simple admin secret check (set ADMIN_SECRET in .env) — kept for the
  // server-to-server billing stub below, which has no JWT.
  function requireAdminSecret(req, res, next) {
    const secret = process.env.ADMIN_SECRET;
    if (!secret || req.headers["x-admin-secret"] !== secret) {
      return res.status(403).json({ ok: false, statusCode: 403, message: "Forbidden" });
    }
    next();
  }

  /**
   * PUT /api/v1/admin/users/:userId/tier
   * Assign a tier to a user (billing stub — call this after payment confirmed).
   *
   * Body: { tier: "FOUNDRY" | "FORGE" | "MINT" | "VAULT" }
   */
  router.put(
    "/users/:userId/tier",
    requireAdminSecret,
    asyncHandler(async (req, res) => {
      const { userId } = req.params;
      const { tier }   = req.body;

      if (!tier || !TIER_ORDER.includes(tier)) {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: `tier harus salah satu dari: ${TIER_ORDER.join(", ")}`,
        });
      }

      const updated = await prisma.userStrategy.upsert({
        where:  { userId },
        update: { tier },
        create: { userId, tier },
      });

      res.json({
        ok:     true,
        userId: updated.userId,
        tier:   updated.tier,
        message: `Tier updated to ${tier}`,
      });
    })
  );

  /**
   * GET /api/v1/admin/users/:userId/tier
   * Get current tier for a user.
   */
  router.get(
    "/users/:userId/tier",
    requireAdminSecret,
    asyncHandler(async (req, res) => {
      const { userId } = req.params;

      const record = await prisma.userStrategy.findUnique({
        where:  { userId },
        select: { tier: true, balanceTier: true, updatedAt: true },
      });

      if (!record) {
        return res.status(404).json({ ok: false, statusCode: 404, message: "User not found" });
      }

      res.json({ ok: true, userId, tier: record.tier, balanceTier: record.balanceTier, updatedAt: record.updatedAt });
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN DASHBOARD ENDPOINTS (ADMIN-BE-03) — JWT + role-guarded.
  // Shapes mirror what fe-bot-trading/src/hooks/useAdmin* expect.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/v1/admin/stats — headline KPI cards (AC-02).
   * → { ok, stats: { totalUsers, activeBots, totalTrades, monthlyRevenue } }
   */
  router.get(
    "/stats",
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const now      = new Date();
      const weekAgo  = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const [totalUsers, newUsersWeek, activeBots, tradeStats, tierRows] =
        await Promise.all([
          prisma.user.count(),
          prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
          prisma.bot.count({ where: { running: true } }),
          // Real trades live in the db-layer `trades` table, not Prisma `Trade`.
          db.getAdminTradeStats(),
          prisma.userStrategy.groupBy({ by: ["tier"], _count: { _all: true } }),
        ]);
      const totalTrades = tradeStats.total || 0;
      const tradesToday = tradeStats.today || 0;

      // MRR estimate = Σ (tier price × subscribers on that tier).
      const monthlyRevenue = tierRows.reduce(
        (sum, r) => sum + (TIER_CONFIG[r.tier]?.price ?? 0) * r._count._all, 0
      );

      res.json({
        ok: true,
        stats: {
          totalUsers:     { value: totalUsers,     deltaLabel: `+${newUsersWeek} this week`, up: true },
          activeBots:     { value: activeBots,      deltaLabel: "Live trading",              up: true },
          totalTrades:    { value: totalTrades,     deltaLabel: `+${tradesToday} today`,     up: true },
          monthlyRevenue: { value: monthlyRevenue,  deltaLabel: "from active tiers",         up: true, currency: "$" },
        },
      });
    })
  );

  /**
   * GET /api/v1/admin/users — list users with derived trading stats (AC-03).
   * Query: limit (≤500), search, tier, status.
   * → { ok, users: [{ id, name, email, joined, tier, exchange, bots, trades, netPnl, status }], total, filtered }
   */
  router.get(
    "/users",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const search = (req.query.search || "").toString().trim().toLowerCase();
      const tier   = (req.query.tier   || "").toString().trim();
      const status = (req.query.status || "").toString().trim();

      const [rows, pnlRows, total] = await Promise.all([
        prisma.user.findMany({
          take: limit,
          orderBy: { createdAt: "desc" },
          select: {
            id: true, email: true, username: true, exchangeType: true, apiKeyHash: true, createdAt: true,
            strategies: { select: { tier: true } },
            bots:       { select: { running: true } },
            exchanges:  { where: { deletedAt: null }, select: { exchangeType: true } },
          },
        }),
        // One pass for trade counts + realized PnL per user (Trade has no userId).
        prisma.$queryRaw`
          SELECT b."userId" AS "userId",
                 COUNT(t.id)::int AS "trades",
                 COALESCE(SUM(t.pnl), 0)::float AS "netPnl"
          FROM "Bot" b
          LEFT JOIN "Trade" t ON t."botId" = b.id
          GROUP BY b."userId"`,
        prisma.user.count(),
      ]);

      const pnlMap = new Map(pnlRows.map(r => [r.userId, r]));

      let users = rows.map(u => {
        const agg        = pnlMap.get(u.id) || { trades: 0, netPnl: 0 };
        const hasRunning = u.bots.some(b => b.running);
        // Only show an exchange when the user has ACTUALLY connected one — an
        // active UserExchange record or a stored key fingerprint. The User
        // exchangeType column defaults to "bitget" even when nothing is linked,
        // so it must not be used as the connection signal.
        const activeExchange = u.exchanges?.[0]?.exchangeType;
        const connected      = !!activeExchange || !!u.apiKeyHash;
        return {
          id:       u.id,
          name:     u.username,
          email:    u.email,
          joined:   u.createdAt.toISOString().slice(0, 10),
          tier:     u.strategies[0]?.tier || "FOUNDRY",
          exchange: connected ? exchangeLabel(activeExchange || u.exchangeType) : "—",
          bots:     u.bots.length,
          trades:   agg.trades,
          netPnl:   Number(agg.netPnl.toFixed(2)),
          status:   hasRunning ? "Active" : "Inactive",
          flagged:  platformStore.isFlagged(u.id),
        };
      });

      // Optional server-side filtering (FE also filters client-side).
      if (search) users = users.filter(u =>
        u.name.toLowerCase().includes(search) ||
        u.email.toLowerCase().includes(search) ||
        u.id.toLowerCase().includes(search));
      if (tier)   users = users.filter(u => u.tier === tier);
      // "Flagged" is a platform-store signal, not a derived activity status —
      // it filters on the flag rather than the Active/Inactive column.
      if (status === "Flagged") users = users.filter(u => u.flagged);
      else if (status)          users = users.filter(u => u.status === status);

      res.json({ ok: true, users, total, filtered: users.length });
    })
  );

  /**
   * GET /api/v1/admin/bots — currently-running bots across all users (AC-06).
   * → { ok, bots: [{ user, symbol, mode, strategy, capital, openPos, roi, since, status }] }
   */
  router.get(
    "/bots",
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const bots = await prisma.bot.findMany({
        where: { running: true },
        orderBy: { startedAt: "desc" },
        select: {
          symbol: true, dryRun: true, strategyKey: true, strategyGroup: true,
          capital: true, startedAt: true,
          user:   { select: { username: true } },
          trades: { select: { status: true, side: true, pnl: true } },
        },
      });

      const result = bots.map(b => {
        const open     = b.trades.filter(t => t.status === "OPEN");
        const realized = b.trades.reduce((s, t) => s + (t.pnl || 0), 0);
        const roi      = b.capital > 0 ? Number(((realized / b.capital) * 100).toFixed(2)) : 0;
        const multi    = Array.isArray(b.strategyGroup) && b.strategyGroup.length > 1;
        return {
          user:     b.user?.username || "—",
          symbol:   b.symbol,
          mode:     b.dryRun ? "Dry Run" : "Live",
          strategy: multi ? "MULTI" : abbrevStrategy(b.strategyKey),
          capital:  `$${b.capital.toLocaleString("en-US")}`,
          openPos:  open.length === 0 ? "None" : `${open.length} ${open[0].side}`,
          roi,
          since:    fmtShort(b.startedAt),
          status:   "Running",
        };
      });

      res.json({ ok: true, bots: result });
    })
  );

  /**
   * GET /api/v1/admin/health — platform health snapshot.
   * Only reports what the API can actually verify (DB ping, running-bot count,
   * process uptime) — no fabricated third-party exchange ping.
   * → { ok, services: [{ label, state, note }], uptime }
   */
  router.get(
    "/health",
    requireAdmin,
    asyncHandler(async (_req, res) => {
      let dbOk = true;
      try { await prisma.$queryRaw`SELECT 1`; } catch { dbOk = false; }

      const runningBots = await prisma.bot.count({ where: { running: true } }).catch(() => 0);

      const up   = Math.floor(process.uptime());
      const h    = Math.floor(up / 3600);
      const m    = Math.floor((up % 3600) / 60);
      const uptime = h > 0 ? `${h}h ${m}m` : `${m}m`;

      res.json({
        ok: true,
        services: [
          { label: "API Server", state: "ok",                note: "Healthy" },
          { label: "WebSocket",  state: "ok",                note: `Connected (${runningBots})` },
          { label: "Database",   state: dbOk ? "ok" : "warn", note: dbOk ? "Healthy" : "Unreachable" },
        ],
        uptime,
      });
    })
  );

  /**
   * GET /api/v1/admin/trades — recent trades across all users, with KPI summary
   * (AC-04). Query: limit (≤200). Trade has no userId, so we join via Bot.
   * → { ok, trades: [{ id, user, symbol, side, strategy, entry, exit, netPnl, opened, status }], kpis, total }
   */
  router.get(
    "/trades",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

      // Read from the REAL trades store (db layer), not the unused Prisma table.
      const [rows, stats] = await Promise.all([
        db.getAdminTrades({ limit }),
        db.getAdminTradeStats(),
      ]);

      const fmtPrice = n => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-US"));
      const trades = rows.map(t => ({
        id:       String(t.id).slice(-6).toUpperCase(),
        user:     t.username || "—",
        symbol:   t.symbol,
        side:     t.side,
        strategy: abbrevStrategy(t.strategy_name),
        entry:    fmtPrice(t.entry_price),
        exit:     t.exit_price === null || t.exit_price === undefined ? "—" : fmtPrice(t.exit_price),
        netPnl:   Number((t.pnl || 0).toFixed(2)),
        opened:   fmtShort(t.open_time),
        ts:       t.open_time ? new Date(t.open_time).toISOString() : null,
        status:   t.close_time === null || t.close_time === undefined ? "Open" : "Closed",
      }));

      const total     = stats.total || 0;
      const closed    = stats.closed || 0;
      const wins      = stats.wins || 0;
      const winRate   = closed ? ((wins / closed) * 100).toFixed(1) : "0.0";
      const netPnl    = stats.net_pnl || 0;
      const netPnlStr = netPnl >= 0 ? `+$${netPnl.toFixed(2)}` : `-$${Math.abs(netPnl).toFixed(2)}`;

      res.json({
        ok: true,
        trades,
        total,
        kpis: [
          { label: "Total Trades",       value: total.toLocaleString("en-US") },
          { label: "Win Rate (closed)",  value: `${winRate}%`, color: wins ? "green" : undefined },
          { label: "Platform Net PnL",   value: netPnlStr, color: netPnl >= 0 ? "green" : "red" },
          { label: "Closed Trades",      value: closed.toLocaleString("en-US") },
        ],
      });
    })
  );

  /**
   * GET /api/v1/admin/activity — recent platform activity from the audit log.
   * → { ok, activity: [{ tone, time, who, text }] }
   */
  router.get(
    "/activity",
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const logs = await prisma.auditLog.findMany({
        take: 12,
        orderBy: { createdAt: "desc" },
        select: {
          action: true, resource: true, resourceId: true, createdAt: true,
          user: { select: { username: true } },
        },
      });

      // Map action → tone + human-readable verb. Unknown actions get a neutral tone.
      const TONE_BY_ACTION = {
        LOGIN: "purple", LOGOUT: "gray", REGISTER: "purple",
        BOT_START: "green", BOT_STOP: "amber",
        STRATEGY_CHANGE: "blue", TRADE_OPEN: "green", TRADE_CLOSE: "blue",
        USER_SUSPEND: "red", USER_ACTIVATE: "green",
        ROLE_CHANGE: "purple", ADMIN_CREATE: "purple", ADMIN_DELETE: "red",
        EMERGENCY_STOP: "red",
      };
      const VERB = {
        LOGIN: "signed in", LOGOUT: "signed out", REGISTER: "registered",
        BOT_START: "started a bot", BOT_STOP: "stopped a bot",
        STRATEGY_CHANGE: "changed strategy", TRADE_OPEN: "opened a trade",
        TRADE_CLOSE: "closed a trade", USER_SUSPEND: "suspended a user",
        USER_ACTIVATE: "activated a user", ROLE_CHANGE: "changed a role",
        ADMIN_CREATE: "created an admin", ADMIN_DELETE: "deleted an admin",
        EMERGENCY_STOP: "triggered emergency stop",
      };
      const p = n => String(n).padStart(2, "0");

      const activity = logs.map(l => {
        const verb = VERB[l.action] || (l.action || "did something").toLowerCase().replace(/_/g, " ");
        const resInfo = l.resource ? ` (${l.resource}${l.resourceId ? ` ${l.resourceId.slice(-6)}` : ""})` : "";
        const d = new Date(l.createdAt);
        return {
          tone: TONE_BY_ACTION[l.action] || "gray",
          time: `${p(d.getHours())}:${p(d.getMinutes())}`,
          who:  l.user?.username || "System",
          text: `${verb}${resInfo}`,
        };
      });

      res.json({ ok: true, activity });
    })
  );

  /**
   * GET /api/v1/admin/subscriptions — tier breakdown with MRR estimate.
   * → { ok, subscriptions: [{ tier, users, mrr, pct, color }] }
   */
  router.get(
    "/subscriptions",
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const rows  = await prisma.userStrategy.groupBy({ by: ["tier"], _count: { _all: true } });
      const total = rows.reduce((s, r) => s + r._count._all, 0) || 1;

      const TIER_COLOR = { FOUNDRY: "green", FORGE: "purple", MINT: "blue", VAULT: "amber" };

      const subscriptions = rows
        .map(r => {
          const users = r._count._all;
          const price = TIER_CONFIG[r.tier]?.price ?? 0;
          return {
            tier:  r.tier,
            users,
            mrr:   `$${(price * users).toLocaleString("en-US")}/mo`,
            pct:   Math.round((users / total) * 100),
            color: TIER_COLOR[r.tier] || "purple",
          };
        })
        .sort((a, b) => b.users - a.users);

      res.json({ ok: true, subscriptions });
    })
  );

  /**
   * GET /api/v1/admin/trades/export — streaming CSV of all trades, all users
   * (ADMIN-BE-04). Cursor-paginated so memory stays flat on large tables.
   */
  // Same per-row fields as the user-facing insight export (history.js
  // TRADE_COLUMNS), with a leading "User" column since admin spans all users.
  const ADMIN_EXPORT_COLUMNS = [
    ["user",       "User"],
    ["id",         "ID"],
    ["sessionId",  "Session ID"],
    ["symbol",     "Symbol"],
    ["side",       "Side"],
    ["strategy",   "Strategy"],
    ["status",     "Status"],
    ["entryPrice", "Entry Price"],
    ["exitPrice",  "Exit Price"],
    ["sl",         "SL"],
    ["tp",         "TP"],
    ["size",       "Size"],
    ["pnl",        "PnL Gross"],
    ["fee",        "Fee"],
    ["funding",    "Funding"],
    ["pnlNet",     "PnL Net"],
    ["pnlPct",     "PnL %"],
    ["plannedRR",  "Planned R:R"],
    ["actualRR",   "Actual R:R"],
    ["duration",   "Duration"],
    ["reason",     "Reason"],
    ["dryRun",     "DryRun"],
    ["mode",       "Mode"],
    ["exchange",   "Exchange"],
    ["openTime",   "Open Time"],
    ["closeTime",  "Close Time"],
    ["isPartial",  "Is Partial"],
    ["result",     "Result"],
  ];

  router.get("/trades/export", ...requireAdmin, async (req, res) => {
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="quantara_admin_trades_${stamp}.csv"`);
      res.write(ADMIN_EXPORT_COLUMNS.map(c => c[1]).join(",") + "\n");

      // Read the REAL trade store (the Prisma Trade table is empty), with the
      // same enriched fields as the user export so admin & user CSVs align.
      const rows = await db.getAdminTradesExport({ limit: 5000 });
      for (const r of rows) {
        res.write(ADMIN_EXPORT_COLUMNS.map(([key]) => csvCell(r[key])).join(",") + "\n");
      }
      res.end();
    } catch (err) {
      // Headers/rows may already be flushed — can't switch to a JSON error now.
      if (!res.headersSent) {
        res.status(500).json({ ok: false, statusCode: 500, message: "Export failed" });
      } else {
        res.end();
      }
    }
  });

  /**
   * GET /api/v1/admin/backtest/export — placeholder (ADMIN-BE-04).
   * Backtests are computed on demand and NOT persisted (no Backtest model in
   * the schema), so there is nothing to stream yet. Returns 501 until a
   * BacktestRun model + persistence lands. The dashboard's Backtest tab uses
   * client-side sample data in the meantime.
   */
  router.get("/backtest/export", ...requireAdmin, (_req, res) => {
    res.status(501).json({
      ok: false,
      statusCode: 501,
      message: "Backtest export not available yet — backtests are not persisted (no Backtest model).",
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // USER DETAIL + MODERATION (ADMIN-BE-03 mutations)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/v1/admin/users/:id — one user + aggregated trade stats (AC-04).
   */
  router.get(
    "/users/:id",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true, email: true, username: true, role: true, suspendedAt: true,
          exchangeType: true, createdAt: true, emailVerifiedAt: true,
          strategies: { select: { tier: true, strategyKey: true } },
          bots: {
            select: {
              symbol: true, running: true, dryRun: true, capital: true,
              strategyKey: true, totalTrades: true, startedAt: true,
            },
          },
        },
      });
      if (!user) {
        return res.status(404).json({ ok: false, statusCode: 404, message: "User not found" });
      }

      const stat = await prisma.$queryRaw`
        SELECT COUNT(t.id)::int AS "trades",
               COALESCE(SUM(t.pnl), 0)::float AS "netPnl",
               COALESCE(SUM(CASE WHEN t.pnl > 0 THEN 1 ELSE 0 END), 0)::int AS "wins",
               COALESCE(SUM(CASE WHEN t.status = 'OPEN' THEN 1 ELSE 0 END), 0)::int AS "openPositions"
        FROM "Bot" b
        LEFT JOIN "Trade" t ON t."botId" = b.id
        WHERE b."userId" = ${id}`;
      const s = stat[0] || {};

      res.json({
        ok: true,
        user: {
          id:            user.id,
          name:          user.username,
          email:         user.email,
          role:          user.role,
          status:        user.suspendedAt ? "Suspended" : (user.bots.some(b => b.running) ? "Active" : "Inactive"),
          suspended:     !!user.suspendedAt,
          joined:        user.createdAt.toISOString().slice(0, 10),
          emailVerified: !!user.emailVerifiedAt,
          tier:          user.strategies[0]?.tier || "FOUNDRY",
          exchange:      exchangeLabel(user.exchangeType),
          bots: user.bots.map(b => ({
            symbol:      b.symbol,
            mode:        b.dryRun ? "Dry Run" : "Live",
            strategy:    abbrevStrategy(b.strategyKey),
            capital:     `$${b.capital.toLocaleString("en-US")}`,
            status:      b.running ? "Running" : "Stopped",
            since:       fmtShort(b.startedAt),
            totalTrades: b.totalTrades,
          })),
          stats: {
            trades:        s.trades || 0,
            netPnl:        Number((s.netPnl || 0).toFixed(2)),
            wins:          s.wins || 0,
            winRate:       s.trades ? Number(((s.wins / s.trades) * 100).toFixed(1)) : 0,
            openPositions: s.openPositions || 0,
          },
        },
      });
    })
  );

  /**
   * PATCH /api/v1/admin/users/:id/status — suspend / activate a user.
   * Body: { action: "suspend" | "activate" }. SUPER_ADMIN accounts are protected.
   */
  router.patch(
    "/users/:id/status",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id }     = req.params;
      const { action } = req.body;
      if (!["suspend", "activate"].includes(action)) {
        return res.status(400).json({ ok: false, statusCode: 400, message: 'action harus "suspend" atau "activate"' });
      }
      const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
      if (!target) {
        return res.status(404).json({ ok: false, statusCode: 404, message: "User not found" });
      }
      if (target.role === "SUPER_ADMIN") {
        return res.status(403).json({ ok: false, statusCode: 403, message: "Cannot suspend a SUPER_ADMIN" });
      }
      const updated = await prisma.user.update({
        where: { id },
        data:  { suspendedAt: action === "suspend" ? new Date() : null },
        select: { id: true, username: true, suspendedAt: true },
      });
      if (action === "suspend") {
        // Kill active sessions so the suspension takes effect immediately.
        await prisma.session.deleteMany({ where: { userId: id } });
      }
      await audit(req, "ADMIN_USER_STATUS", "user", id, { action });
      res.json({ ok: true, user: { id: updated.id, username: updated.username, status: updated.suspendedAt ? "Suspended" : "Active" } });
    })
  );

  // Shared role-change handler (SUPER_ADMIN only) — guards against demoting the
  // last super admin. Mounted for both users and the admin-management view.
  const changeRole = asyncHandler(async (req, res) => {
    const { id }   = req.params;
    const { role } = req.body;
    if (!ALL_ROLES.includes(role)) {
      return res.status(400).json({ ok: false, statusCode: 400, message: `role harus salah satu: ${ALL_ROLES.join(", ")}` });
    }
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
    if (!target) {
      return res.status(404).json({ ok: false, statusCode: 404, message: "User not found" });
    }
    if (target.role === "SUPER_ADMIN" && role !== "SUPER_ADMIN") {
      const supers = await prisma.user.count({ where: { role: "SUPER_ADMIN" } });
      if (supers <= 1) {
        return res.status(400).json({ ok: false, statusCode: 400, message: "Tidak bisa menurunkan SUPER_ADMIN terakhir" });
      }
    }
    const updated = await prisma.user.update({
      where: { id }, data: { role },
      select: { id: true, username: true, email: true, role: true },
    });
    await audit(req, "ADMIN_CHANGE_ROLE", "user", id, { from: target.role, to: role });
    res.json({ ok: true, user: updated });
  });

  router.patch("/users/:id/role", ...requireSuperAdmin, changeRole);

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN MANAGEMENT — SUPER_ADMIN only (ADMIN-BE-07)
  // ═══════════════════════════════════════════════════════════════════════════

  /** GET /api/v1/admin/admins — list ADMIN + SUPER_ADMIN accounts. */
  router.get(
    "/admins",
    requireSuperAdmin,
    asyncHandler(async (_req, res) => {
      const admins = await prisma.user.findMany({
        where:   { role: { in: MANAGEABLE_ROLES } },
        orderBy: { createdAt: "asc" },
        select:  { id: true, username: true, email: true, role: true, suspendedAt: true, createdAt: true },
      });
      res.json({
        ok: true,
        admins: admins.map(a => ({
          id:       a.id,
          name:     a.username,
          username: a.username,
          email:    a.email,
          role:     a.role,
          status:   a.suspendedAt ? "Suspended" : "Active",
          joined:   a.createdAt.toISOString().slice(0, 10),
        })),
      });
    })
  );

  /** POST /api/v1/admin/admins — create a new admin. */
  router.post(
    "/admins",
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const { email, username, password, role = "ADMIN" } = req.body;
      if (!email || !username || !password) {
        return res.status(400).json({ ok: false, statusCode: 400, message: "email, username, password wajib diisi" });
      }
      if (!MANAGEABLE_ROLES.includes(role)) {
        return res.status(400).json({ ok: false, statusCode: 400, message: `role harus: ${MANAGEABLE_ROLES.join(", ")}` });
      }
      if (String(password).length < 8) {
        return res.status(400).json({ ok: false, statusCode: 400, message: "Password minimal 8 karakter" });
      }
      const clash = await prisma.user.findFirst({ where: { OR: [{ email }, { username }] }, select: { id: true } });
      if (clash) {
        return res.status(409).json({ ok: false, statusCode: 409, message: "Email atau username sudah dipakai" });
      }
      const hashed = await bcrypt.hash(password, 12);
      const created = await prisma.user.create({
        data: {
          email, username, password: hashed, role,
          emailVerifiedAt: new Date(),
          strategies: { create: { strategyKey: "ADAPTIVE_FUSION" } },
        },
        select: { id: true, username: true, email: true, role: true },
      });
      await audit(req, "ADMIN_CREATE_ADMIN", "admin", created.id, { email, role });
      res.status(201).json({ ok: true, admin: created });
    })
  );

  /** PATCH /api/v1/admin/admins/:id — edit username / email. */
  router.patch(
    "/admins/:id",
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const { id }             = req.params;
      const { username, email } = req.body;
      const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
      if (!target || !MANAGEABLE_ROLES.includes(target.role)) {
        return res.status(404).json({ ok: false, statusCode: 404, message: "Admin not found" });
      }
      const data = {};
      if (username) data.username = username;
      if (email)    data.email    = email;
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ ok: false, statusCode: 400, message: "Tidak ada field untuk diubah" });
      }
      try {
        const updated = await prisma.user.update({ where: { id }, data, select: { id: true, username: true, email: true, role: true } });
        await audit(req, "ADMIN_EDIT_ADMIN", "admin", id, data);
        res.json({ ok: true, admin: updated });
      } catch (err) {
        if (err.code === "P2002") {
          return res.status(409).json({ ok: false, statusCode: 409, message: "Email atau username sudah dipakai" });
        }
        throw err;
      }
    })
  );

  /** PATCH /api/v1/admin/admins/:id/role — change an admin's role. */
  router.patch("/admins/:id/role", ...requireSuperAdmin, changeRole);

  /** POST /api/v1/admin/admins/:id/reset-password — set a new password. */
  router.post(
    "/admins/:id/reset-password",
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const { id }       = req.params;
      const { password } = req.body;
      if (!password || String(password).length < 8) {
        return res.status(400).json({ ok: false, statusCode: 400, message: "Password minimal 8 karakter" });
      }
      const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
      if (!target || !MANAGEABLE_ROLES.includes(target.role)) {
        return res.status(404).json({ ok: false, statusCode: 404, message: "Admin not found" });
      }
      const hashed = await bcrypt.hash(password, 12);
      await prisma.user.update({ where: { id }, data: { password: hashed } });
      await prisma.session.deleteMany({ where: { userId: id } }); // force re-login
      await audit(req, "ADMIN_RESET_PASSWORD", "admin", id, null);
      res.json({ ok: true, message: "Password reset — admin must log in again." });
    })
  );

  /** DELETE /api/v1/admin/admins/:id — remove an admin (guards self + last super admin). */
  router.delete(
    "/admins/:id",
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      if (id === req.adminUser.id) {
        return res.status(400).json({ ok: false, statusCode: 400, message: "Tidak bisa menghapus akun sendiri" });
      }
      const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, username: true } });
      if (!target || !MANAGEABLE_ROLES.includes(target.role)) {
        return res.status(404).json({ ok: false, statusCode: 404, message: "Admin not found" });
      }
      if (target.role === "SUPER_ADMIN") {
        const supers = await prisma.user.count({ where: { role: "SUPER_ADMIN" } });
        if (supers <= 1) {
          return res.status(400).json({ ok: false, statusCode: 400, message: "Tidak bisa menghapus SUPER_ADMIN terakhir" });
        }
      }
      await prisma.user.delete({ where: { id } });
      await audit(req, "ADMIN_DELETE_ADMIN", "admin", id, { username: target.username });
      res.json({ ok: true, deletedId: id });
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN v2 — supporting endpoints (ADMIN-BE-05 / ADMIN-BE-08)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/v1/admin/bots/stop-all — EMERGENCY stop every running bot across
   * ALL users/exchanges (ADMIN-BE-05, AC-ADMIN-08). SUPER_ADMIN only; the FE
   * gates this behind a typed "STOP ALL" double-confirmation.
   */
  router.post(
    "/bots/stop-all",
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const dbRunning = await prisma.bot.count({ where: { running: true } });
      // 1) Halt in-memory engines (Engine.stop() closes live positions).
      const mem = typeof stopAllBotsInMemory === "function"
        ? stopAllBotsInMemory()
        : { stopped: 0, failed: 0 };
      // 2) Flip DB flags so persisted state is consistent even for bots that
      //    were not resident in this process's memory.
      const flip = await prisma.bot.updateMany({ where: { running: true }, data: { running: false } });
      await audit(req, "EMERGENCY_STOP", "platform", null, {
        dbRunning, memStopped: mem.stopped, memFailed: mem.failed, dbFlipped: flip.count,
      });
      // 3) Best-effort Telegram broadcast — never blocks/breaks the response.
      const who = req.adminUser?.email || req.adminUser?.username || req.adminUser?.id;
      telegram.send(`⛔ <b>EMERGENCY STOP ALL BOTS</b>\nBy: ${who}\nHalted: ${flip.count} bot(s)`, "HTML").catch(() => {});
      res.json({ ok: true, stopped: flip.count, memStopped: mem.stopped, failed: mem.failed });
    })
  );

  /**
   * GET /api/v1/admin/audit — full AuditLog viewer, paginated + filterable
   * (ADMIN-FE-12, AC-ADMIN-14). Query: page, limit (≤100), action, actor
   * (username/email substring), from, to (ISO dates).
   */
  router.get(
    "/audit",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const page   = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const limit  = Math.min(parseInt(req.query.limit, 10) || 25, 100);
      const action = (req.query.action || "").toString().trim();
      const actor  = (req.query.actor  || "").toString().trim();
      const from   = req.query.from ? new Date(req.query.from) : null;
      const to     = req.query.to   ? new Date(req.query.to)   : null;

      const where = {};
      if (action) where.action = action;
      if (from && !isNaN(from.getTime())) where.createdAt = { ...(where.createdAt || {}), gte: from };
      if (to   && !isNaN(to.getTime()))   where.createdAt = { ...(where.createdAt || {}), lte: to };
      if (actor) where.user = { OR: [
        { username: { contains: actor, mode: "insensitive" } },
        { email:    { contains: actor, mode: "insensitive" } },
      ] };

      const [total, rows, actionGroups] = await Promise.all([
        prisma.auditLog.count({ where }),
        prisma.auditLog.findMany({
          where, orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit, take: limit,
          select: {
            id: true, action: true, resource: true, resourceId: true,
            details: true, ipAddress: true, userAgent: true, createdAt: true,
            user: { select: { username: true, email: true } },
          },
        }),
        prisma.auditLog.groupBy({ by: ["action"], orderBy: { action: "asc" } }),
      ]);

      const entries = rows.map(l => ({
        id:         l.id,
        action:     l.action,
        actor:      l.user?.username || "System",
        actorEmail: l.user?.email || null,
        resource:   l.resource || null,
        resourceId: l.resourceId || null,
        details:    l.details || null,
        ip:         l.ipAddress || null,
        userAgent:  l.userAgent || null,
        at:         l.createdAt.toISOString(),
        time:       fmtShort(l.createdAt),
      }));

      res.json({
        ok: true, entries, total, page, limit,
        pages:   Math.ceil(total / limit) || 1,
        actions: actionGroups.map(g => g.action),
      });
    })
  );

  /**
   * GET /api/v1/admin/settings — platform settings (ADMIN-FE-11, AC-ADMIN-13).
   * Returns env-derived flags (read-only) + store-backed maintenance/flags.
   * SUPER_ADMIN only.
   */
  router.get(
    "/settings",
    requireSuperAdmin,
    asyncHandler(async (_req, res) => {
      const s = platformStore.getSettings();
      res.json({
        ok: true,
        settings: {
          maintenanceMode:  s.maintenanceMode,
          featureFlags:     s.featureFlags,
          // Env-derived — read-only here (set via deploy/.env). null = "all".
          allowedTiers:     cfg.allowedTiers     || TIER_ORDER,
          allowedExchanges: cfg.allowedExchanges || ["bitget", "okx", "binance"],
          tiersLocked:      !!cfg.allowedTiers,
          exchangesLocked:  !!cfg.allowedExchanges,
          env:              cfg.NODE_ENV,
        },
      });
    })
  );

  /**
   * PATCH /api/v1/admin/settings — toggle maintenance / feature flags.
   * Body: { maintenanceMode?: bool, featureFlags?: object }. Audited. SUPER_ADMIN.
   */
  router.patch(
    "/settings",
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const { maintenanceMode, featureFlags } = req.body || {};
      if (maintenanceMode === undefined && featureFlags === undefined) {
        return res.status(400).json({ ok: false, statusCode: 400, message: "Tidak ada perubahan settings" });
      }
      if (maintenanceMode !== undefined && typeof maintenanceMode !== "boolean") {
        return res.status(400).json({ ok: false, statusCode: 400, message: "maintenanceMode harus boolean" });
      }
      const { before, after } = platformStore.patchSettings({ maintenanceMode, featureFlags });
      await audit(req, "ADMIN_SETTINGS_CHANGE", "settings", null, { before, after });
      res.json({ ok: true, settings: after });
    })
  );

  /**
   * GET /api/v1/admin/strategy-stats — aggregate performance per strategy across
   * all users (ADMIN-FE-08, AC-ADMIN-16). Query: days (trailing window).
   */
  router.get(
    "/strategy-stats",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const days      = parseInt(req.query.days, 10);
      const sinceDays = Number.isFinite(days) && days > 0 ? days : null;
      const rows = await db.getAdminStrategyStats({ sinceDays });

      const strategies = rows.map(r => ({
        key:     r.strategy,
        label:   abbrevStrategy(r.strategy),
        name:    r.strategy,
        total:   r.total,
        closed:  r.closed,
        wins:    r.wins,
        winRate: r.closed ? Number(((r.wins / r.closed) * 100).toFixed(1)) : 0,
        netPnl:  Number((r.net_pnl || 0).toFixed(2)),
        avgPnl:  Number((r.avg_pnl || 0).toFixed(2)),
      }));

      res.json({ ok: true, strategies, window: sinceDays ? `${sinceDays}d` : "all" });
    })
  );

  /**
   * GET /api/v1/admin/alerts — operational alert feed (ADMIN-FE-10, AC-ADMIN-18).
   * Derived from REAL signals only: DB health, flagged users, and recent
   * high-severity audit events. No fabricated alerts.
   */
  router.get(
    "/alerts",
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const now = new Date().toISOString();
      const alerts = [];

      let dbOk = true;
      try { await prisma.$queryRaw`SELECT 1`; } catch { dbOk = false; }
      if (!dbOk) {
        alerts.push({ id: "db-down", severity: "critical", title: "Database unreachable",
          detail: "Primary database failed its health check.", at: now });
      }

      const flagged = platformStore.listFlagged();
      if (flagged.length) {
        alerts.push({ id: "flagged-users", severity: "warning",
          title: `${flagged.length} flagged user${flagged.length > 1 ? "s" : ""}`,
          detail: "Accounts under manual review — see Flagged Users.", at: now });
      }

      // Recent high-severity admin/audit events become alert items.
      const SEV = { EMERGENCY_STOP: "critical", ADMIN_DELETE_ADMIN: "warning", ADMIN_USER_STATUS: "info" };
      const recent = await prisma.auditLog.findMany({
        where: { action: { in: Object.keys(SEV) } },
        orderBy: { createdAt: "desc" }, take: 10,
        select: { id: true, action: true, resourceId: true, createdAt: true, user: { select: { username: true } } },
      });
      for (const l of recent) {
        const verb = l.action === "EMERGENCY_STOP" ? "Emergency stop triggered"
                   : l.action === "ADMIN_DELETE_ADMIN" ? "Admin account deleted"
                   : "User status changed";
        alerts.push({
          id: `audit-${l.id}`, severity: SEV[l.action] || "info",
          title: verb, detail: `by ${l.user?.username || "System"}`,
          at: l.createdAt.toISOString(), time: fmtShort(l.createdAt),
        });
      }

      const RANK = { critical: 0, warning: 1, info: 2 };
      alerts.sort((a, b) => (RANK[a.severity] - RANK[b.severity]) || (a.at < b.at ? 1 : -1));

      res.json({ ok: true, alerts, count: alerts.length });
    })
  );

  /**
   * GET /api/v1/admin/apikeys — audit of users' exchange connections
   * (ADMIN-FE-07, AC-ADMIN-12). SUPER_ADMIN only.
   * SECURITY: returns ONLY masked metadata — never apiKey/apiSecret plaintext.
   */
  router.get(
    "/apikeys",
    requireSuperAdmin,
    asyncHandler(async (_req, res) => {
      const rows = await prisma.userExchange.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true, exchangeType: true, apiKey: true, label: true,
          createdAt: true, updatedAt: true,
          user: { select: { id: true, username: true, email: true } },
        },
      });
      const connections = rows.map(x => ({
        id:          x.id,
        userId:      x.user?.id || null,
        user:        x.user?.username || "—",
        email:       x.user?.email || null,
        exchange:    exchangeLabel(x.exchangeType),
        fingerprint: maskKey(x.apiKey), // masked only — raw key never leaves here
        label:       x.label || null,
        status:      "Connected",
        connectedAt: x.createdAt.toISOString().slice(0, 10),
        lastUpdated: fmtShort(x.updatedAt),
      }));
      res.json({ ok: true, connections, total: connections.length });
    })
  );

  /**
   * POST /api/v1/admin/users/:id/flag — flag a user for review (ADMIN-FE-05).
   * Body: { reason? }. DELETE clears the flag. Both audited.
   */
  router.post(
    "/users/:id/flag",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id }     = req.params;
      const { reason } = req.body || {};
      const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
      if (!target) return res.status(404).json({ ok: false, statusCode: 404, message: "User not found" });
      const meta = platformStore.flagUser(id, reason, req.adminUser?.id);
      await audit(req, "ADMIN_USER_FLAG", "user", id, { reason: meta.reason });
      res.json({ ok: true, flagged: { userId: id, ...meta } });
    })
  );

  router.delete(
    "/users/:id/flag",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const existed = platformStore.clearFlag(id);
      if (existed) await audit(req, "ADMIN_USER_CLEAR_FLAG", "user", id, null);
      res.json({ ok: true, cleared: existed });
    })
  );

  return router;
};
