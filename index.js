// ─────────────────────────────────────────────
// index.js — Quantara Trading Bot
// Bitget Futures & OKX Swap | Node.js
//
// Cara pakai:
//   cp .env.example .env
//   nano .env               (isi API key + EXCHANGE=bitget atau okx)
//   npm install
//   node index.js           (DRY_RUN=true untuk simulasi)
//
// Ganti exchange:
//   EXCHANGE=okx node index.js
// ─────────────────────────────────────────────

require("dotenv").config();

const { createExchangeClient, getExchangeInfo } = require("./exchange-factory");
const { calcIndicators, detectSignal, calcPositionSize } = require("./indicators");
const logger          = require("./logger");

// ── Pilih exchange ──
const exchangeInfo = getExchangeInfo();

// ── Config dari .env ──
const CONFIG = {
  exchange:        exchangeInfo.id,
  exchangeLabel:   exchangeInfo.label,
  // OKX pakai instId (BTC-USDT-SWAP), Bitget pakai symbol (BTCUSDT)
  symbol:          exchangeInfo.id === "okx"
                     ? (process.env.OKX_INST_ID || "BTC-USDT-SWAP")
                     : (process.env.SYMBOL       || "BTCUSDT"),
  marginCoin:      process.env.MARGIN_COIN     || "USDT",
  productType:     process.env.PRODUCT_TYPE    || "umcbl",
  emaFast:         parseInt(process.env.EMA_FAST)       || 9,
  emaSlow:         parseInt(process.env.EMA_SLOW)       || 21,
  rsiPeriod:       parseInt(process.env.RSI_PERIOD)     || 14,
  rsiOverbought:   parseInt(process.env.RSI_OVERBOUGHT) || 70,
  rsiOversold:     parseInt(process.env.RSI_OVERSOLD)   || 30,
  atrPeriod:       parseInt(process.env.ATR_PERIOD)     || 14,
  atrMultiplier:   parseFloat(process.env.ATR_MULTIPLIER) || 2,
  riskReward:      parseFloat(process.env.RISK_REWARD)  || 3,
  riskPerTrade:    parseFloat(process.env.RISK_PER_TRADE) || 0.02,
  maxPositions:    parseInt(process.env.MAX_OPEN_POSITIONS) || 1,
  leverage:        parseInt(process.env.LEVERAGE)       || 3,
  useBothSides:    process.env.USE_BOTH_SIDES === "true",
  interval:        process.env.CANDLE_INTERVAL          || "4H",
  checkInterval:   parseInt(process.env.CHECK_INTERVAL_MS) || 60000,
  dryRun:          process.env.DRY_RUN !== "false",
};

// State bot
const state = {
  running:       false,
  openPositions: [],
  trades:        [],
  capital:       0,
  startCapital:  0,
  lastSignal:    null,
  checkCount:    0,
  errors:        0,
};

// Exchange client (Bitget atau OKX tergantung .env)
const client = createExchangeClient();

// ─────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────
async function startup() {
  logger.separator(`QUANTARA BOT — ${CONFIG.exchangeLabel.toUpperCase()}`);
  logger.info(`Exchange   : ${CONFIG.exchangeLabel}`);
  logger.info(`Mode       : ${CONFIG.dryRun ? "DRY RUN (simulasi)" : "LIVE TRADING"}`);
  logger.info(`Symbol     : ${CONFIG.symbol}`);
  logger.info(`Interval   : ${CONFIG.interval}`);
  logger.info(`EMA        : Fast(${CONFIG.emaFast}) / Slow(${CONFIG.emaSlow})`);
  logger.info(`RSI        : Period ${CONFIG.rsiPeriod} | OB ${CONFIG.rsiOverbought} | OS ${CONFIG.rsiOversold}`);
  logger.info(`ATR SL     : ${CONFIG.atrMultiplier}x ATR`);
  logger.info(`TP         : ${CONFIG.atrMultiplier * CONFIG.riskReward}x ATR (R:R 1:${CONFIG.riskReward})`);
  logger.info(`Risk/trade : ${(CONFIG.riskPerTrade * 100).toFixed(0)}% modal`);
  logger.info(`Leverage   : ${CONFIG.leverage}x`);
  logger.info(`Sides      : ${CONFIG.useBothSides ? "LONG + SHORT" : "LONG only"}`);
  logger.separator();

  // Deteksi API key berdasarkan exchange
  const apiKeyEnv = CONFIG.exchange === "okx" ? process.env.OKX_API_KEY : process.env.BITGET_API_KEY;
  const apiKeyMissing = !apiKeyEnv || apiKeyEnv === "your_api_key_here";

  if (apiKeyMissing) {
    if (!CONFIG.dryRun) {
      logger.error(`API Key ${CONFIG.exchange.toUpperCase()} belum diisi di .env! Set DRY_RUN=true untuk simulasi.`);
      process.exit(1);
    }
    logger.warn("API Key kosong — berjalan dalam mode DRY RUN tanpa koneksi exchange");
  } else {
    // Cek balance
    try {
      const balance = await client.getBalance(CONFIG.marginCoin);
      state.capital      = balance.available;
      state.startCapital = balance.available;
      logger.info(`Balance    : $${balance.available.toFixed(2)} USDT available`);
      logger.info(`Equity     : $${balance.equity.toFixed(2)} USDT`);

      // Set leverage
      if (!CONFIG.dryRun) {
        await client.setLeverage(CONFIG.symbol, CONFIG.leverage);
        await client.setMarginMode(CONFIG.symbol, "crossed");
        logger.info(`Leverage   : ${CONFIG.leverage}x diset ✓`);
      }
    } catch (err) {
      logger.error(`Gagal connect ke ${CONFIG.exchangeLabel}:`, err.message);
      if (!CONFIG.dryRun) process.exit(1);
      state.capital = state.startCapital = 500; // Default untuk dry run
    }
  }

  logger.separator("BOT BERJALAN");
}

// ─────────────────────────────────────────────
// MAIN LOOP — dipanggil setiap checkInterval
// ─────────────────────────────────────────────
async function tick() {
  state.checkCount++;

  try {
    // 1. Ambil candles
    const candles = await fetchCandles();
    if (!candles || candles.length < CONFIG.emaSlow + 20) {
      logger.warn("Candle tidak cukup untuk kalkulasi indikator");
      return;
    }

    // 2. Hitung indikator
    const indicators = calcIndicators(candles, {
      emaFast:   CONFIG.emaFast,
      emaSlow:   CONFIG.emaSlow,
      rsiPeriod: CONFIG.rsiPeriod,
      atrPeriod: CONFIG.atrPeriod,
    });

    const lastIdx  = candles.length - 2; // pakai candle sebelumnya (closed)
    const lastCandle = candles[lastIdx];
    const price    = lastCandle.close;
    const emaF     = indicators.emaFast[lastIdx];
    const emaS     = indicators.emaSlow[lastIdx];
    const rsi      = indicators.rsi[lastIdx];
    const atr      = indicators.atr[lastIdx];

    // 3. Log harga + indikator setiap 5 tick
    if (state.checkCount % 5 === 1) {
      logger.price(
        `${CONFIG.symbol} $${price.toLocaleString()} |`,
        `EMA(${CONFIG.emaFast})=${emaF?.toFixed(2)} EMA(${CONFIG.emaSlow})=${emaS?.toFixed(2)} |`,
        `RSI=${rsi?.toFixed(1)} ATR=${atr?.toFixed(2)} |`,
        `Trend: ${emaF > emaS ? "↑ BULLISH" : "↓ BEARISH"}`
      );
    }

    // 4. Cek posisi yang terbuka
    await checkOpenPositions(price, atr);

    // 5. Deteksi sinyal baru
    if (state.openPositions.length < CONFIG.maxPositions) {
      const signal = detectSignal(indicators, lastIdx, {
        rsiOverbought: CONFIG.rsiOverbought,
        rsiOversold:   CONFIG.rsiOversold,
        useBothSides:  CONFIG.useBothSides,
      });

      if (signal && signal !== state.lastSignal) {
        await handleSignal(signal, price, atr);
        state.lastSignal = signal;
      } else if (!signal) {
        state.lastSignal = null;
      }
    }

    state.errors = 0; // reset error counter pada sukses

  } catch (err) {
    state.errors++;
    logger.error(`Tick error (${state.errors}):`, err.message);
    if (state.errors >= 5) {
      logger.error("5 error berturut-turut! Bot berhenti. Cek koneksi/API key.");
      process.exit(1);
    }
  }
}

// ─────────────────────────────────────────────
// FETCH CANDLES (dengan fallback dry-run)
// ─────────────────────────────────────────────
async function fetchCandles() {
  if (CONFIG.dryRun && (!process.env.BITGET_API_KEY || process.env.BITGET_API_KEY === "your_api_key_here")) {
    return generateDryRunCandles();
  }
  try {
    return await client.getCandles(CONFIG.symbol, CONFIG.interval, 200);
  } catch (err) {
    logger.warn("Gagal ambil candles dari Bitget, pakai data simulasi:", err.message);
    return generateDryRunCandles();
  }
}

// Simulasi candle untuk dry run
function generateDryRunCandles(n = 200) {
  let price = 65000;
  const candles = [];
  const now = Date.now();
  const intervalMs = CONFIG.interval === "1H" ? 3600000
    : CONFIG.interval === "4H" ? 14400000
    : CONFIG.interval === "1D" ? 86400000 : 14400000;

  let trend = 0.0005;
  for (let i = n; i >= 0; i--) {
    if (i % 40 === 0) trend = (Math.random() - 0.5) * 0.003;
    const change  = trend + (Math.random() - 0.5) * 0.025;
    const open    = price;
    const close   = Math.max(price * (1 + change), price * 0.8);
    const high    = Math.max(open, close) * (1 + Math.random() * 0.008);
    const low     = Math.min(open, close) * (1 - Math.random() * 0.008);
    candles.push({
      timestamp: now - i * intervalMs,
      date: new Date(now - i * intervalMs).toISOString(),
      open: +open.toFixed(2), high: +high.toFixed(2),
      low: +low.toFixed(2), close: +close.toFixed(2),
      volume: Math.random() * 1000,
    });
    price = close;
  }
  return candles;
}

// ─────────────────────────────────────────────
// HANDLE SIGNAL — Buka posisi baru
// ─────────────────────────────────────────────
async function handleSignal(signal, price, atr) {
  if (!atr) { logger.warn("ATR tidak tersedia, skip signal"); return; }

  const slDistance = atr * CONFIG.atrMultiplier;
  const tpDistance = slDistance * CONFIG.riskReward;

  const sl = signal === "LONG" ? price - slDistance : price + slDistance;
  const tp = signal === "LONG" ? price + tpDistance : price - tpDistance;

  // Position sizing
  const availableCapital = CONFIG.dryRun ? state.capital : (await client.getBalance(CONFIG.marginCoin)).available;
  const size = calcPositionSize(availableCapital, CONFIG.riskPerTrade, price, sl);

  if (size <= 0) {
    logger.warn("Position size terlalu kecil, skip signal");
    return;
  }

  logger.separator(`SINYAL ${signal}`);
  logger.trade(`📡 SINYAL: ${signal} ${CONFIG.symbol}`);
  logger.trade(`   Entry : $${price.toLocaleString()}`);
  logger.trade(`   SL    : $${sl.toFixed(2)} (-${((slDistance/price)*100).toFixed(2)}%)`);
  logger.trade(`   TP    : $${tp.toFixed(2)} (+${((tpDistance/price)*100).toFixed(2)}%)`);
  logger.trade(`   Size  : ${size} (Risk: $${(availableCapital * CONFIG.riskPerTrade).toFixed(2)})`);
  logger.trade(`   ATR   : ${atr.toFixed(2)}`);

  if (!CONFIG.dryRun) {
    // ── LIVE ORDER ──
    try {
      const side = signal === "LONG" ? "open_long" : "open_short";
      const order = await client.openPosition(CONFIG.symbol, side, size);
      logger.trade(`✅ Order dikirim! Order ID: ${order?.orderId || "N/A"}`);

      // Pasang SL & TP
      const holdSide = signal === "LONG" ? "long" : "short";
      await client.setTPSL(CONFIG.symbol, "loss_plan",   sl.toFixed(2), holdSide, size);
      await client.setTPSL(CONFIG.symbol, "profit_plan", tp.toFixed(2), holdSide, size);
      logger.trade(`✅ SL/TP dipasang`);

      state.openPositions.push({
        id: order?.orderId, side: signal, entry: price,
        sl, tp, size, openTime: Date.now(), atr,
      });
    } catch (err) {
      logger.error("Gagal buka posisi:", err.message);
    }
  } else {
    // ── DRY RUN ──
    logger.trade(`🟡 [DRY RUN] Order TIDAK dikirim ke exchange`);
    state.capital -= availableCapital * CONFIG.riskPerTrade; // simulasi freeze margin
    state.openPositions.push({
      id: `dry_${Date.now()}`, side: signal, entry: price,
      sl, tp, size, openTime: Date.now(), atr,
    });
  }

  await logger.notifyTrade("OPEN", CONFIG.symbol, signal, price, size);
}

// ─────────────────────────────────────────────
// CEK POSISI TERBUKA — SL/TP/Exit
// ─────────────────────────────────────────────
async function checkOpenPositions(currentPrice, atr) {
  if (state.openPositions.length === 0) return;

  if (!CONFIG.dryRun) {
    // Untuk live: cek dari API apakah posisi masih ada
    try {
      const livePositions = await client.getPositions(CONFIG.symbol);
      // Sinkronisasi
      state.openPositions = state.openPositions.filter(p => {
        return livePositions.some(lp => lp.side === p.side);
      });
      return;
    } catch { /* pakai state lokal */ }
  }

  // Dry run: simulasi SL/TP
  const toClose = [];
  for (const pos of state.openPositions) {
    const hitTP = pos.side === "LONG" ? currentPrice >= pos.tp : currentPrice <= pos.tp;
    const hitSL = pos.side === "LONG" ? currentPrice <= pos.sl : currentPrice >= pos.sl;

    if (hitTP || hitSL) {
      const exitPrice = hitTP ? pos.tp : pos.sl;
      const pnl = pos.side === "LONG"
        ? (exitPrice - pos.entry) * pos.size
        : (pos.entry - exitPrice) * pos.size;

      state.capital += pnl;
      state.capital += pos.entry * pos.size * CONFIG.riskPerTrade; // kembalikan margin

      const reason   = hitTP ? "TAKE PROFIT ✅" : "STOP LOSS ❌";
      const duration = Math.round((Date.now() - pos.openTime) / 60000);

      logger.separator(`POSISI DITUTUP — ${reason}`);
      logger.trade(`${hitTP ? "✅" : "❌"} CLOSE ${pos.side} — ${reason}`);
      logger.trade(`   Entry  : $${pos.entry.toLocaleString()}`);
      logger.trade(`   Exit   : $${exitPrice.toFixed(2)}`);
      logger.trade(`   PnL    : ${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)}`);
      logger.trade(`   Durasi : ${duration} menit`);
      logger.trade(`   Modal  : $${state.capital.toFixed(2)}`);

      state.trades.push({ ...pos, exit: exitPrice, pnl, reason, closedAt: Date.now() });
      toClose.push(pos.id);

      await logger.notifyTrade("CLOSE", CONFIG.symbol, pos.side, exitPrice, pos.size, pnl);
    }
  }

  state.openPositions = state.openPositions.filter(p => !toClose.includes(p.id));
}

// ─────────────────────────────────────────────
// STATUS REPORT — setiap 1 jam
// ─────────────────────────────────────────────
function printStatusReport() {
  const totalPnL = state.trades.reduce((s, t) => s + t.pnl, 0);
  const wins = state.trades.filter(t => t.pnl > 0).length;
  const losses = state.trades.filter(t => t.pnl <= 0).length;
  const winRate = state.trades.length > 0 ? (wins / state.trades.length * 100).toFixed(1) : "N/A";

  logger.separator("STATUS REPORT");
  logger.info(`Capital    : $${state.capital.toFixed(2)} (awal: $${state.startCapital.toFixed(2)})`);
  logger.info(`Total PnL  : ${totalPnL > 0 ? "+" : ""}$${totalPnL.toFixed(2)} (${((totalPnL/state.startCapital)*100).toFixed(2)}%)`);
  logger.info(`Trades     : ${state.trades.length} total | ${wins}W / ${losses}L | WR ${winRate}%`);
  logger.info(`Open pos   : ${state.openPositions.length}`);
  logger.info(`Checks     : ${state.checkCount} kali`);
  logger.separator();
}

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────
async function shutdown(signal) {
  logger.warn(`\nMenerima ${signal} — Bot berhenti...`);
  printStatusReport();

  if (!CONFIG.dryRun && state.openPositions.length > 0) {
    logger.warn("⚠️  Ada posisi terbuka! Tutup manual di Bitget jika perlu.");
    for (const pos of state.openPositions) {
      logger.warn(`   - ${pos.side} ${CONFIG.symbol} | Entry: $${pos.entry} | Size: ${pos.size}`);
    }
  }

  logger.info("Bot berhenti. Sampai jumpa! 👋");
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception:", err.message);
  logger.error(err.stack);
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
async function main() {
  await startup();
  state.running = true;

  // Jalankan tick pertama langsung
  await tick();

  // Loop utama
  const mainInterval = setInterval(tick, CONFIG.checkInterval);

  // Status report setiap 1 jam
  const reportInterval = setInterval(printStatusReport, 60 * 60 * 1000);

  logger.info(`⏱️  Bot akan cek setiap ${CONFIG.checkInterval / 1000} detik`);
  logger.info(`   Tekan Ctrl+C untuk berhenti`);
}

main().catch(err => {
  logger.error("Fatal error saat startup:", err.message);
  process.exit(1);
});
