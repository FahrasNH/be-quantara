/**
 * Unit test Grok AI Live Trading — parse, validate, prompt builder.
 * Run: node test/grok-trading.test.js
 */

const GrokTradingService = require("../src/server/services/GrokTradingService");
const GrokTradingPromptBuilder = require("../src/server/services/GrokTradingPromptBuilder");

let pass = 0;
let fail = 0;
const pending = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pending.push(
        result.then(() => {
          pass++;
          console.log(`  ✓ ${name}`);
        }).catch((err) => {
          fail++;
          console.log(`  ✗ ${name}: ${err.message}`);
        })
      );
      return;
    }
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

const baseCtx = {
  symbol: "BTCUSDT",
  price: 98000,
  atr: 500,
  atrMinMult: 1.0,
  minRiskReward: 1.2,
  minConfidenceEntry: 8,
  minConfidenceTpSl: 7,
  hasOpenPosition: false,
};

console.log("\n=== Grok Trading Tests ===\n");

test("parseResponse — JSON valid", () => {
  const raw = JSON.stringify({
    trades: [{ symbol: "BTCUSDT", side: "LONG", confidence: 8, take_profit: 99000, stop_loss: 97000 }],
    position_actions: [],
  });
  const parsed = GrokTradingService.parseResponse(raw);
  if (parsed.trades.length !== 1) throw new Error("expected 1 trade");
});

test("parseResponse — markdown-wrapped JSON", () => {
  const raw = '```json\n{"trades":[],"position_actions":[]}\n```';
  const parsed = GrokTradingService.parseResponse(raw);
  if (!Array.isArray(parsed.trades)) throw new Error("trades must be array");
});

test("parseResponse — invalid throws", () => {
  let threw = false;
  try {
    GrokTradingService.parseResponse("not json at all");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("should throw on invalid JSON");
});

test("validateTrade — LONG geometry valid conf 8", () => {
  const trade = {
    symbol: "BTCUSDT",
    side: "LONG",
    confidence: 8,
    take_profit: 99200,
    stop_loss: 97000,
    reasoning: "bullish align",
  };
  const v = GrokTradingService.validateTrade(trade, baseCtx);
  if (!v.valid || !v.entryAllowed || !v.tpSlValid) throw new Error(`should accept full entry: ${v.rejected}`);
  if (v.side !== "LONG") throw new Error("wrong side");
});

test("validateTrade — SHORT geometry valid", () => {
  const trade = {
    symbol: "BTCUSDT",
    side: "SHORT",
    confidence: 9,
    take_profit: 96000,
    stop_loss: 99500,
  };
  const v = GrokTradingService.validateTrade(trade, { ...baseCtx, price: 98000, atr: 400 });
  if (!v.entryAllowed) throw new Error(`SHORT entry should be allowed: ${v.rejected}`);
});

test("validateTrade — reject entry conf 7 (TP/SL tier only)", () => {
  const trade = {
    symbol: "BTCUSDT",
    side: "LONG",
    confidence: 7,
    take_profit: 99200,
    stop_loss: 97000,
  };
  const v = GrokTradingService.validateTrade(trade, baseCtx);
  if (!v.tpSlValid) throw new Error(`TP/SL should be valid at conf 7: ${v.rejected}`);
  if (v.entryAllowed) throw new Error("entry must be rejected at conf 7");
});

test("validateTrade — reject TP/SL conf 6", () => {
  const trade = {
    symbol: "BTCUSDT",
    side: "LONG",
    confidence: 6,
    take_profit: 99000,
    stop_loss: 97000,
  };
  const v = GrokTradingService.validateTrade(trade, baseCtx);
  if (v.valid || v.tpSlValid) throw new Error("conf 6 should be fully rejected");
});

test("validateTrade — reject LONG bad geometry", () => {
  const trade = {
    symbol: "BTCUSDT",
    side: "LONG",
    confidence: 8,
    take_profit: 97000,
    stop_loss: 99000,
  };
  const v = GrokTradingService.validateTrade(trade, baseCtx);
  if (v.valid) throw new Error("inverted TP/SL should fail");
});

test("validateTrade — reject SL too tight vs ATR", () => {
  const trade = {
    symbol: "BTCUSDT",
    side: "LONG",
    confidence: 8,
    take_profit: 99000,
    stop_loss: 97900,
  };
  const v = GrokTradingService.validateTrade(trade, baseCtx);
  if (v.valid) throw new Error("SL tighter than 1×ATR should fail");
});

test("validateTrade — reject low risk/reward", () => {
  const trade = {
    symbol: "BTCUSDT",
    side: "LONG",
    confidence: 8,
    take_profit: 98100,
    stop_loss: 97000,
  };
  const v = GrokTradingService.validateTrade(trade, baseCtx);
  if (v.valid) throw new Error("RR < 1.2 should fail");
});

test("validateTrade — reject wrong symbol", () => {
  const trade = {
    symbol: "ETHUSDT",
    side: "LONG",
    confidence: 8,
    take_profit: 99000,
    stop_loss: 97000,
  };
  const v = GrokTradingService.validateTrade(trade, baseCtx);
  if (v.valid) throw new Error("symbol mismatch should fail");
});

test("GrokTradingPromptBuilder — required fields present", () => {
  const closes = Array.from({ length: 50 }, (_, i) => 97000 + i * 10);
  const candles = closes.map((c, i) => ({
    open: c, high: c + 5, low: c - 5, close: c, volume: 100,
    timestamp: Date.now() - (50 - i) * 60_000,
  }));
  const indicators = {
    closes,
    highs: candles.map(c => c.high),
    lows: candles.map(c => c.low),
    atr: closes.map(() => 500),
  };
  const built = GrokTradingPromptBuilder.build({
    symbol: "BTCUSDT",
    price: 98000,
    indicators,
    lastIdx: closes.length - 2,
    multiTfCandles: { "15m": candles, "1h": candles },
    account: { balance: 500, openPositions: [] },
    minConfidenceEntry: 8,
    minConfidenceTpSl: 7,
  });
  if (!built.text.includes("BTCUSDT")) throw new Error("missing symbol");
  if (!built.text.includes("confidence >= 8")) throw new Error("missing entry threshold");
  if (!built.text.includes("confidence >= 7")) throw new Error("missing tp/sl threshold");
  if (!built.payload.current_price) throw new Error("missing current_price");
  if (!built.hasRequiredSections) throw new Error("required sections missing");
});

test("requestTradeDecision — mock client returns validated trade", async () => {
  const fixture = JSON.stringify({
    trades: [{
      symbol: "BTCUSDT",
      side: "LONG",
      confidence: 8,
      take_profit: 99200,
      stop_loss: 97000,
      reasoning: "multi-TF align",
    }],
    position_actions: [],
  });

  const origEnabled = GrokTradingService.isEnabled;
  const origClient = GrokTradingService._client;
  GrokTradingService.isEnabled = () => true;
  GrokTradingService._client = {
    isConfigured: true,
    chat: async () => fixture,
  };

  try {
    const decision = await GrokTradingService.requestTradeDecision({
      symbol: "BTCUSDT",
      price: 98000,
      atr: 500,
      userId: "test-user",
      hasOpenPosition: false,
    });
    if (!decision?.entryAllowed) throw new Error(`expected entry allowed: ${decision?.rejected}`);
    if (decision.take_profit !== 99200) throw new Error("wrong TP");
  } finally {
    GrokTradingService.isEnabled = origEnabled;
    GrokTradingService._client = origClient;
  }
});

async function runAll() {
  await Promise.all(pending);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exitCode = 1;
}

runAll();
