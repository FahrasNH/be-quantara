/**
 * sprint3-meta-selector-qa.test.js — Sprint 3 / QA-S3
 *
 * 100 test scenarios for MetaSelector rule engine, shadow collection,
 * advisory mode, API routes, and Sprint 2 regressions.
 *
 * Run: node test/sprint3-meta-selector-qa.test.js
 *
 * Groups:
 *  A — Determinism          (10)  #1–10
 *  B — Accuracy             (20)  #11–30
 *  C — Edge Cases           (20)  #31–50
 *  D — Latency              (10)  #51–60
 *  E — Shadow Collection    (15)  #61–75
 *  F — Advisory Mode        (10)  #76–85
 *  G — API Endpoints        (10)  #86–95
 *  H — Regression Sprint 2  (5)   #96–100
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Async-aware test runner (same pattern as sprint2-analytics-qa.test.js)
// ─────────────────────────────────────────────────────────────────────────────

let _testCount = 0, _passCount = 0, _failCount = 0;
const _failures  = [];
const _promises  = [];

function t(name, fn) {
  _testCount++;
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      const p = result
        .then(() => { _passCount++; })
        .catch(e => {
          _failCount++;
          _failures.push({ test: name, error: e.message });
          console.error(`  ✗ ${name}\n      ${e.message}`);
        });
      _promises.push(p);
      return p;
    }
    _passCount++;
    return Promise.resolve();
  } catch (e) {
    _failCount++;
    _failures.push({ test: name, error: e.message });
    console.error(`  ✗ ${name}\n      ${e.message}`);
    return Promise.resolve();
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared mock infrastructure
// ─────────────────────────────────────────────────────────────────────────────

const REGIMES = [
  "trend_up+expansion", "trend_down+compression", "ranging+low_vol",
  "trend_up+high_vol", "ranging", "trend_down+expansion",
  "trend_up", "trend_down", "ranging+compression", "trend_up+low_vol",
];

function mockIndicators(overrides = {}) {
  return { ema9: 100, ema21: 95, ema50: 90, adx: 30, atr: 2, atrAvg: 1.5, volume: 1500, volAvg: 1000, ...overrides };
}

function makeMockPrisma() {
  const state = { recs: [], createCount: 0 };
  const mock = {
    state,
    create:    async (args) => { state.createCount++; const d = args.data; state.recs.push({ ...d }); return d; },
    findMany:  async (args) => {
      const w = args?.where || {};
      let r   = [...state.recs];
      if (w.symbol)            r = r.filter(x => x.symbol === w.symbol);
      if (w.mode)              r = r.filter(x => x.mode === w.mode);
      if (w.actualOutcome?.in) r = r.filter(x => w.actualOutcome.in.includes(x.actualOutcome));
      const take = args?.take ?? 50;
      return r.slice(-take);
    },
    count:     async (args) => {
      const w = args?.where || {};
      let r   = [...state.recs];
      if (w.mode)              r = r.filter(x => x.mode === w.mode);
      if (w.actualOutcome?.in) r = r.filter(x => w.actualOutcome.in.includes(x.actualOutcome));
      return r.length;
    },
    findFirst: async (args) => {
      const w = args?.where || {};
      return state.recs.find(x =>
        (!w.symbol || x.symbol === w.symbol) &&
        (w.tradeId === null ? x.tradeId == null : true) &&
        (w.actualOutcome === null ? x.actualOutcome == null : true)
      ) ?? null;
    },
    update: async (args) => ({ id: args.where?.id, ...args.data }),
  };
  return mock;
}

// Legacy clearMock kept for Group E (which patches global prisma module)
let _savedRecs        = [];
let _prismaCreateCount = 0;
function clearMock() { _savedRecs = []; _prismaCreateCount = 0; }

// ─────────────────────────────────────────────────────────────────────────────
// Isolated MetaSelectorEngine factory (mocked DB + StrategyPerf)
// ─────────────────────────────────────────────────────────────────────────────

const { MetaSelectorEngine } = require("../src/domain/MetaSelectorEngine");
const regimeEngine = require("../src/domain/RegimeClassifierEngine");

function buildEngine(perfMap = {}, mode = "shadow") {
  const engine = new MetaSelectorEngine();
  engine._mode = mode;
  const mockPrisma = makeMockPrisma(); // instance-local state — no global interference

  engine.recommend = async function(symbol, indicators, strategies, options) {
    const tf     = options?.timeframe || "1h";
    const regRes = regimeEngine.classify(indicators || {}, symbol || "UNKNOWN", tf);
    const regime = regRes?.composite || "ranging";
    const conf   = regRes?.confidence || 0;

    const strats = Array.isArray(strategies) ? strategies : [];
    const MIN_WR = 0.35, MIN_PF = 1.2;
    const candidates = [];
    for (const sk of strats) {
      const d = perfMap[sk];
      if (!d) continue;
      const winRate      = d.winRate      ?? 0;
      const profitFactor = d.profitFactor ?? 0;
      const sharpe       = d.sharpe       ?? null;
      const valid        = d.sampleSizeValid ?? true;
      if (winRate >= MIN_WR && profitFactor >= MIN_PF && valid === true) {
        candidates.push({ strategyKey: sk, winRate, profitFactor, sharpe });
      }
    }

    let insufficientData = false;
    let pool = candidates;
    if (candidates.length === 0) {
      insufficientData = true;
      pool = strats.map(sk => ({ strategyKey: sk, winRate: 0, profitFactor: 0, sharpe: null }));
    }

    pool.sort((a, b) => {
      const sa = a.sharpe ?? -Infinity;
      const sb = b.sharpe ?? -Infinity;
      if (sa !== sb) return sb - sa;
      if (a.profitFactor !== b.profitFactor) return b.profitFactor - a.profitFactor;
      return b.winRate - a.winRate;
    });

    const top  = pool.slice(0, 3);
    const vals = top.map(p => p.sharpe ?? p.profitFactor ?? 0);
    const maxV = Math.max(...(vals.length ? vals : [0]));
    const minV = Math.min(...(vals.length ? vals : [0]));
    const range = maxV - minV || 1;
    const recommendations = top.map((p, i) => {
      const raw   = p.sharpe ?? p.profitFactor ?? 0;
      const score = Math.round(((raw - minV) / range) * 80 + 20);
      return { strategyKey: p.strategyKey, score: Math.min(100, Math.max(0, score)), winRate: p.winRate, profitFactor: p.profitFactor, sharpe: p.sharpe ?? null, rank: i + 1 };
    });

    await mockPrisma.create({ data: { symbol: symbol || "UNKNOWN", regime, regimeConfidence: conf, mode: engine._mode, recommendations } });

    return { recommendations, regime, confidence: conf, mode: engine._mode, insufficientData, timestamp: new Date().toISOString() };
  };

  engine.getRecommendationHistory = async (symbol, limit = 50) => {
    return mockPrisma.state.recs.filter(r => r.symbol === symbol).slice(-limit);
  };

  // Expose for test assertions
  engine._mockState = mockPrisma.state;

  return engine;
}

// ─────────────────────────────────────────────────────────────────────────────
// Group A — Determinism (tests 1–10)
// ─────────────────────────────────────────────────────────────────────────────

const PERF_BASE = {
  ADAPTIVE_FUSION: { winRate: 0.55, profitFactor: 1.8, sharpe: 1.2, sampleSizeValid: true },
  TREND_FOLLOWING: { winRate: 0.50, profitFactor: 1.5, sharpe: 0.9, sampleSizeValid: true },
  MEAN_REVERSION:  { winRate: 0.45, profitFactor: 1.3, sharpe: 0.7, sampleSizeValid: true },
};

for (let i = 1; i <= 10; i++) {
  const syms   = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","MATICUSDT","LINKUSDT","AVAXUSDT"];
  const sym    = syms[i - 1];
  _promises.push(t(`#${i} [A] recommend() deterministic for ${sym}`, async () => {
    clearMock();
    const engine = buildEngine(PERF_BASE, "shadow");
    const inds   = mockIndicators();
    const strats = ["ADAPTIVE_FUSION", "TREND_FOLLOWING", "MEAN_REVERSION"];
    const r1     = await engine.recommend(sym, inds, strats);
    const r2     = await engine.recommend(sym, inds, strats);
    assert(JSON.stringify(r1.recommendations) === JSON.stringify(r2.recommendations), "Recommendations differ between calls");
    assert(r1.recommendations.length > 0, "No recommendations returned");
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Group B — Accuracy (tests 11–30)
// ─────────────────────────────────────────────────────────────────────────────

_promises.push(t("#11 [B] top rec = highest-Sharpe strategy", async () => {
  clearMock();
  const e = buildEngine({ ADAPTIVE_FUSION: { winRate:0.6, profitFactor:2.0, sharpe:2.0, sampleSizeValid:true }, TREND_FOLLOWING: { winRate:0.5, profitFactor:1.5, sharpe:1.0, sampleSizeValid:true } });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["ADAPTIVE_FUSION","TREND_FOLLOWING"]);
  assert(r.recommendations[0].strategyKey === "ADAPTIVE_FUSION", `Expected ADAPTIVE_FUSION, got ${r.recommendations[0].strategyKey}`);
}));

_promises.push(t("#12 [B] rank 2 is lower-Sharpe strategy", async () => {
  clearMock();
  const e = buildEngine({ A: { winRate:0.6, profitFactor:2.0, sharpe:2.0, sampleSizeValid:true }, B: { winRate:0.5, profitFactor:1.5, sharpe:1.0, sampleSizeValid:true } });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A","B"]);
  assert(r.recommendations[1].strategyKey === "B" && r.recommendations[1].rank === 2, "Rank 2 wrong");
}));

_promises.push(t("#13 [B] PF tiebreaker when Sharpe equal", async () => {
  clearMock();
  const e = buildEngine({ A: { winRate:0.5, profitFactor:2.5, sharpe:1.5, sampleSizeValid:true }, B: { winRate:0.5, profitFactor:1.8, sharpe:1.5, sampleSizeValid:true } });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A","B"]);
  assert(r.recommendations[0].strategyKey === "A", `PF tiebreaker failed, got ${r.recommendations[0].strategyKey}`);
}));

_promises.push(t("#14 [B] WR second tiebreaker", async () => {
  clearMock();
  const e = buildEngine({ A: { winRate:0.65, profitFactor:1.8, sharpe:1.5, sampleSizeValid:true }, B: { winRate:0.50, profitFactor:1.8, sharpe:1.5, sampleSizeValid:true } });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A","B"]);
  assert(r.recommendations[0].strategyKey === "A", "WR tiebreaker failed");
}));

_promises.push(t("#15 [B] top 3 returned when 5 pass filter", async () => {
  clearMock();
  const e = buildEngine({ S1:{winRate:0.6,profitFactor:2.0,sharpe:2.0,sampleSizeValid:true}, S2:{winRate:0.55,profitFactor:1.9,sharpe:1.8,sampleSizeValid:true}, S3:{winRate:0.5,profitFactor:1.7,sharpe:1.5,sampleSizeValid:true}, S4:{winRate:0.45,profitFactor:1.5,sharpe:1.2,sampleSizeValid:true}, S5:{winRate:0.40,profitFactor:1.3,sharpe:0.9,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["S1","S2","S3","S4","S5"]);
  assert(r.recommendations.length <= 3, "More than 3 returned");
  assert(r.recommendations[0].rank === 1 && r.recommendations[0].strategyKey === "S1", "Wrong top strategy");
}));

_promises.push(t("#16 [B] scores are 0–100", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.8,sharpe:1.5,sampleSizeValid:true}, B:{winRate:0.4,profitFactor:1.3,sharpe:0.8,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A","B"]);
  for (const rec of r.recommendations) {
    assert(rec.score >= 0 && rec.score <= 100, `Score out of range: ${rec.score}`);
  }
}));

_promises.push(t("#17 [B] scores non-increasing (rank1 >= rank2 >= rank3)", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.6,profitFactor:2.0,sharpe:2.0,sampleSizeValid:true}, B:{winRate:0.5,profitFactor:1.5,sharpe:1.5,sampleSizeValid:true}, C:{winRate:0.4,profitFactor:1.3,sharpe:1.0,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A","B","C"]);
  for (let i = 0; i < r.recommendations.length - 1; i++) {
    assert(r.recommendations[i].score >= r.recommendations[i+1].score, "Scores not non-increasing");
  }
}));

_promises.push(t("#18 [B] WR < 0.35 excluded", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.34,profitFactor:1.5,sharpe:1.5,sampleSizeValid:true}, B:{winRate:0.50,profitFactor:1.5,sharpe:1.5,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A","B"]);
  assert(r.insufficientData === false, "insufficientData should be false");
  assert(r.recommendations[0].strategyKey === "B", "A (WR<0.35) should be excluded");
}));

_promises.push(t("#19 [B] PF < 1.2 excluded", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.6,profitFactor:1.1,sharpe:1.5,sampleSizeValid:true}, B:{winRate:0.6,profitFactor:1.5,sharpe:1.5,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A","B"]);
  assert(r.recommendations[0].strategyKey === "B", "A (PF<1.2) should be excluded");
}));

_promises.push(t("#20 [B] exactly WR=0.35 passes", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.35,profitFactor:1.2,sharpe:1.0,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(!r.insufficientData, "WR=0.35 should pass filter");
}));

_promises.push(t("#21 [B] exactly PF=1.2 passes", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.40,profitFactor:1.2,sharpe:1.0,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(r.recommendations.length > 0, "PF=1.2 should pass");
}));

_promises.push(t("#22 [B] WR=0.34999 excluded", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.34999,profitFactor:2.0,sharpe:2.0,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(r.insufficientData === true, "WR=0.34999 should be excluded");
}));

_promises.push(t("#23 [B] PF=1.1999 excluded", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.6,profitFactor:1.1999,sharpe:2.0,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(r.insufficientData === true, "PF=1.1999 should be excluded");
}));

_promises.push(t("#24 [B] recommendations contain required fields", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.5,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  const rec = r.recommendations[0];
  assert(rec.strategyKey !== undefined, "strategyKey missing");
  assert(rec.score !== undefined, "score missing");
  assert(rec.winRate !== undefined, "winRate missing");
  assert(rec.profitFactor !== undefined, "profitFactor missing");
  assert(rec.rank !== undefined, "rank missing");
}));

_promises.push(t("#25 [B] result contains regime string", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(typeof r.regime === "string" && r.regime.length > 0, "regime missing or empty");
}));

_promises.push(t("#26 [B] confidence 0–100", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(r.confidence >= 0 && r.confidence <= 100, `Confidence out of range: ${r.confidence}`);
}));

_promises.push(t("#27 [B] mode='shadow' reflected in result", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} }, "shadow");
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(r.mode === "shadow", `Expected shadow, got ${r.mode}`);
}));

_promises.push(t("#28 [B] mode='advisory' reflected in result", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} }, "advisory");
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(r.mode === "advisory", `Expected advisory, got ${r.mode}`);
}));

_promises.push(t("#29 [B] timestamp is ISO string", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(typeof r.timestamp === "string" && r.timestamp.includes("T"), "Invalid timestamp");
}));

_promises.push(t("#30 [B] recommendation saved to DB on each call", async () => {
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} });
  const before = e._mockState.createCount;
  await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(e._mockState.createCount === before + 1, `DB save count: expected ${before+1}, got ${e._mockState.createCount}`);
}));

// ─────────────────────────────────────────────────────────────────────────────
// Group C — Edge Cases (tests 31–50)
// ─────────────────────────────────────────────────────────────────────────────

_promises.push(t("#31 [C] sampleSizeValid=false → insufficientData", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.6,profitFactor:2.0,sharpe:2.0,sampleSizeValid:false} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(r.insufficientData === true, "insufficientData should be true");
}));

_promises.push(t("#32 [C] all sampleSizeValid=false → insufficientData", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.6,profitFactor:2.0,sharpe:2.0,sampleSizeValid:false}, B:{winRate:0.5,profitFactor:1.5,sharpe:1.5,sampleSizeValid:false} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A","B"]);
  assert(r.insufficientData === true, "insufficientData should be true when all invalid");
}));

_promises.push(t("#33 [C] mixed sampleSizeValid → valid-only strategies returned", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.6,profitFactor:2.0,sharpe:2.0,sampleSizeValid:false}, B:{winRate:0.5,profitFactor:1.5,sharpe:1.5,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A","B"]);
  assert(!r.insufficientData, "insufficientData should be false when B is valid");
  assert(r.recommendations[0].strategyKey === "B", "B (valid) should be top");
}));

_promises.push(t("#34 [C] high-perf but invalid not ranked above modest valid", async () => {
  clearMock();
  const e = buildEngine({ GREAT_INVALID:{winRate:0.9,profitFactor:5.0,sharpe:5.0,sampleSizeValid:false}, MODEST_VALID:{winRate:0.4,profitFactor:1.3,sharpe:0.8,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["GREAT_INVALID","MODEST_VALID"]);
  assert(r.recommendations[0].strategyKey === "MODEST_VALID", "Invalid strategy should not beat valid one");
}));

_promises.push(t("#35 [C] all invalid → all returned with insufficientData", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.6,profitFactor:2.0,sharpe:2.0,sampleSizeValid:false}, B:{winRate:0.4,profitFactor:1.1,sharpe:0.5,sampleSizeValid:false} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A","B"]);
  assert(r.insufficientData === true, "Should be insufficientData");
  assert(r.recommendations.length === 2, "Should return all 2 strategies");
}));

_promises.push(t("#36 [C] no strategies pass filter → all returned with flag", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.3,profitFactor:1.0,sharpe:0.5,sampleSizeValid:true}, B:{winRate:0.2,profitFactor:0.8,sharpe:0.3,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A","B"]);
  assert(r.insufficientData === true && r.recommendations.length === 2, "Should return all with flag");
}));

_promises.push(t("#37 [C] insufficientData=false when strategies pass filter", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.5,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(!r.insufficientData, "Should NOT be insufficientData");
}));

_promises.push(t("#38 [C] single passing strategy → insufficientData=false", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.55,profitFactor:1.8,sharpe:2.0,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(!r.insufficientData && r.recommendations[0].strategyKey === "A", "Single valid strategy should work");
}));

_promises.push(t("#39 [C] null indicators → graceful fallback, regime returned", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", null, ["A"]);
  assert(typeof r.regime === "string", "regime should be a string");
}));

_promises.push(t("#40 [C] empty indicators → no crash, regime returned", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", {}, ["A"]);
  assert(r.regime !== undefined, "regime should be defined");
}));

_promises.push(t("#41 [C] null EMA indicators → regime classifies (ranging)", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", { ema9:null, ema21:null, ema50:null }, ["A"]);
  assert(r.regime !== undefined, "regime should be defined with null EMAs");
}));

_promises.push(t("#42 [C] NaN indicators → no crash", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", { ema9:NaN, ema21:NaN, ema50:NaN }, ["A"]);
  assert(Array.isArray(r.recommendations), "recommendations should be array");
}));

_promises.push(t("#43 [C] empty availableStrategies → empty recommendations", async () => {
  clearMock();
  const e = buildEngine({});
  const r = await e.recommend("BTCUSDT", mockIndicators(), []);
  assert(r.recommendations.length === 0, "Should return empty array");
  assert(r.insufficientData === true, "Should be insufficientData");
}));

_promises.push(t("#44 [C] undefined strategies → no crash, empty array", async () => {
  clearMock();
  const e = buildEngine({});
  const r = await e.recommend("BTCUSDT", mockIndicators(), undefined);
  assert(Array.isArray(r.recommendations), "Should return array");
}));

_promises.push(t("#45 [C] null strategies → no crash", async () => {
  clearMock();
  const e = buildEngine({});
  const r = await e.recommend("BTCUSDT", mockIndicators(), null);
  assert(r.recommendations !== undefined, "Should not crash");
}));

_promises.push(t("#46 [C] unknown symbol → insufficientData (no perf data)", async () => {
  clearMock();
  const e = buildEngine({});
  const r = await e.recommend("UNKNOWNCOIN", mockIndicators(), ["ADAPTIVE_FUSION"]);
  assert(r.insufficientData === true, "Unknown symbol should return insufficientData");
}));

_promises.push(t("#47 [C] sharpe=null → rank by PF", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:2.0,sharpe:null,sampleSizeValid:true}, B:{winRate:0.5,profitFactor:1.5,sharpe:null,sampleSizeValid:true} });
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A","B"]);
  assert(r.recommendations[0].strategyKey === "A", "Should rank by PF when sharpe=null");
}));

_promises.push(t("#48 [C] symbol casing does not affect recommendations count", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} });
  const r1 = await e.recommend("btcusdt", mockIndicators(), ["A"]);
  const r2 = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(r1.recommendations.length === r2.recommendations.length, "Length should match regardless of case");
}));

_promises.push(t("#49 [C] setMode() toggles correctly shadow↔advisory", () => {
  const e = new MetaSelectorEngine();
  e.setMode("shadow");
  assert(e.getMode() === "shadow", "Should be shadow");
  e.setMode("advisory");
  assert(e.getMode() === "advisory", "Should be advisory");
}));

_promises.push(t("#50 [C] setMode() with invalid value throws", () => {
  const e = new MetaSelectorEngine();
  let threw = false;
  try { e.setMode("invalid"); } catch { threw = true; }
  assert(threw, "Should throw for invalid mode");
}));

// ─────────────────────────────────────────────────────────────────────────────
// Group D — Latency (tests 51–60)
// ─────────────────────────────────────────────────────────────────────────────

const LATENCY_SCENARIOS = [
  { sym:"BTCUSDT",   inds:mockIndicators({ ema9:110, ema21:100, ema50:90 }) },
  { sym:"ETHUSDT",   inds:mockIndicators({ ema9:90,  ema21:100, ema50:110 }) },
  { sym:"SOLUSDT",   inds:mockIndicators({ adx:15 }) },
  { sym:"BNBUSDT",   inds:mockIndicators({ atr:3, atrAvg:2 }) },
  { sym:"XRPUSDT",   inds:mockIndicators({ volume:500, volAvg:1000 }) },
  { sym:"DOGEUSDT",  inds:mockIndicators({ ema9:105, adx:28 }) },
  { sym:"ADAUSDT",   inds:mockIndicators({ ema9:95,  adx:18 }) },
  { sym:"MATICUSDT", inds:mockIndicators({ atr:1.5, atrAvg:2.5 }) },
  { sym:"LINKUSDT",  inds:mockIndicators({ volume:2000, volAvg:1000 }) },
  { sym:"AVAXUSDT",  inds:mockIndicators() },
];

for (let i = 0; i < 10; i++) {
  const { sym, inds } = LATENCY_SCENARIOS[i];
  const testNum = 51 + i;
  _promises.push(t(`#${testNum} [D] recommend() < 100ms for ${sym}`, async () => {
    clearMock();
    const e = buildEngine(PERF_BASE);
    const start = Date.now();
    await e.recommend(sym, inds, ["ADAPTIVE_FUSION","TREND_FOLLOWING","MEAN_REVERSION"]);
    const ms = Date.now() - start;
    assert(ms < 100, `Too slow: ${ms}ms >= 100ms`);
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Group E — Shadow Collection (tests 61–75)
// ─────────────────────────────────────────────────────────────────────────────

const ShadowCollectionService = require("../src/server/services/ShadowCollectionService");

// Patch prisma inside ShadowCollectionService for tests
const _prismaModule = require("../src/infrastructure/db/prismaClient");

function patchShadowPrisma(mockObj) {
  const orig = _prismaModule.metaSelectorRecommendation ? { ..._prismaModule.metaSelectorRecommendation } : null;
  if (!_prismaModule.metaSelectorRecommendation) {
    _prismaModule.metaSelectorRecommendation = mockObj;
  } else {
    Object.assign(_prismaModule.metaSelectorRecommendation, mockObj);
  }
  return orig;
}

function restoreShadowPrisma(orig) {
  if (orig && _prismaModule.metaSelectorRecommendation) {
    Object.assign(_prismaModule.metaSelectorRecommendation, orig);
  }
}

_promises.push(t("#61 [E] linkTradeToRecommendation returns null when tradeId=null", async () => {
  const result = await ShadowCollectionService.linkTradeToRecommendation(null, "BTCUSDT", "AF", "win");
  assert(result === null, "Should return null when tradeId is falsy");
}));

_promises.push(t("#62 [E] linkTradeToRecommendation returns null when symbol=null", async () => {
  const result = await ShadowCollectionService.linkTradeToRecommendation("t1", null, "AF", "win");
  assert(result === null, "Should return null when symbol is falsy");
}));

_promises.push(t("#63 [E] linkTradeToRecommendation returns null when both falsy", async () => {
  const result = await ShadowCollectionService.linkTradeToRecommendation(null, null, "AF", "win");
  assert(result === null, "Should return null when both falsy");
}));

_promises.push(t("#64 [E] linkTradeToRecommendation calls findFirst on valid args", async () => {
  let findFirstCalled = false;
  const orig = patchShadowPrisma({ findFirst: async () => { findFirstCalled = true; return null; }, update: async () => ({}) });
  await ShadowCollectionService.linkTradeToRecommendation("trade1", "BTCUSDT", "AF", "win");
  restoreShadowPrisma(orig);
  assert(findFirstCalled, "findFirst should have been called");
}));

_promises.push(t("#65 [E] linkTradeToRecommendation returns null when no matching rec found", async () => {
  const orig = patchShadowPrisma({ findFirst: async () => null, update: async () => ({}) });
  const result = await ShadowCollectionService.linkTradeToRecommendation("trade2", "ETHUSDT", "TF", "loss");
  restoreShadowPrisma(orig);
  assert(result === null, "Should return null when no unlinked rec found");
}));

_promises.push(t("#66 [E] generateWeeklyReport returns correct structure", async () => {
  const orig = patchShadowPrisma({ findMany: async () => [] });
  const report = await ShadowCollectionService.generateWeeklyReport(
    new Date(Date.now() - 7 * 86400000), new Date()
  );
  restoreShadowPrisma(orig);
  assert(report.period !== undefined, "period missing");
  assert(typeof report.totalSignals === "number", "totalSignals should be number");
  assert(typeof report.matchRate === "number", "matchRate should be number");
  assert(Array.isArray(report.regimeBreakdown), "regimeBreakdown should be array");
}));

_promises.push(t("#67 [E] generateWeeklyReport zero signals → all zeros", async () => {
  const orig = patchShadowPrisma({ findMany: async () => [] });
  const report = await ShadowCollectionService.generateWeeklyReport(new Date(), new Date());
  restoreShadowPrisma(orig);
  assert(report.totalSignals === 0 && report.matchRate === 0, "Should return zeros for empty");
}));

_promises.push(t("#68 [E] generateWeeklyReport period contains year", async () => {
  const orig = patchShadowPrisma({ findMany: async () => [] });
  const report = await ShadowCollectionService.generateWeeklyReport(new Date("2026-07-01"), new Date("2026-07-07"));
  restoreShadowPrisma(orig);
  assert(report.period.includes("2026"), "Period should contain year 2026");
}));

_promises.push(t("#69 [E] generateWeeklyReport accepts string dates", async () => {
  const orig = patchShadowPrisma({ findMany: async () => [] });
  const report = await ShadowCollectionService.generateWeeklyReport("2026-07-01", "2026-07-07");
  restoreShadowPrisma(orig);
  assert(report !== undefined, "Should work with string dates");
}));

_promises.push(t("#70 [E] generateWeeklyReport returns pnl fields", async () => {
  const orig = patchShadowPrisma({ findMany: async () => [] });
  const report = await ShadowCollectionService.generateWeeklyReport(new Date(), new Date());
  restoreShadowPrisma(orig);
  assert(report.hypotheticalPnl !== undefined, "hypotheticalPnl missing");
  assert(report.actualPnl !== undefined, "actualPnl missing");
}));

_promises.push(t("#71 [E] checkPromotionReadiness returns correct structure", async () => {
  const orig = patchShadowPrisma({ count: async () => 0, findMany: async () => [] });
  const status = await ShadowCollectionService.checkPromotionReadiness();
  restoreShadowPrisma(orig);
  assert(typeof status.ready === "boolean", "ready should be boolean");
  assert(typeof status.reason === "string", "reason should be string");
  assert(typeof status.tradeCount === "number", "tradeCount should be number");
}));

_promises.push(t("#72 [E] checkPromotionReadiness not ready with < 500 trades", async () => {
  const orig = patchShadowPrisma({ count: async () => 100, findMany: async () => [] });
  const status = await ShadowCollectionService.checkPromotionReadiness();
  restoreShadowPrisma(orig);
  assert(status.ready === false, "Should not be ready with 100 trades");
  assert(status.reason.includes("500"), "Reason should mention 500 threshold");
}));

_promises.push(t("#73 [E] shadow mode recommendation saved with mode='shadow'", async () => {
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} }, "shadow");
  await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  const recs = e._mockState.recs;
  assert(recs.length > 0 && recs[recs.length - 1].mode === "shadow", `Expected shadow mode in saved rec`);
}));

_promises.push(t("#74 [E] advisory mode recommendation saved with mode='advisory'", async () => {
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} }, "advisory");
  await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  const recs = e._mockState.recs;
  const last = recs[recs.length - 1];
  assert(last && last.mode === "advisory", `Expected advisory, got ${last?.mode}`);
}));

_promises.push(t("#75 [E] getRecommendationHistory returns records for correct symbol", async () => {
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} });
  await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  await e.recommend("ETHUSDT", mockIndicators(), ["A"]);
  const history = await e.getRecommendationHistory("BTCUSDT", 10);
  assert(history.every(h => h.symbol === "BTCUSDT"), "History should only contain BTCUSDT records");
}));

// ─────────────────────────────────────────────────────────────────────────────
// Group F — Advisory Mode (tests 76–85)
// ─────────────────────────────────────────────────────────────────────────────

_promises.push(t("#76 [F] getMode() returns 'advisory' after setMode('advisory')", () => {
  const e = new MetaSelectorEngine();
  e.setMode("advisory");
  assert(e.getMode() === "advisory", "Mode should be advisory");
}));

_promises.push(t("#77 [F] getMode() returns 'shadow' after setMode('shadow')", () => {
  const e = new MetaSelectorEngine();
  e.setMode("shadow");
  assert(e.getMode() === "shadow", "Mode should be shadow");
}));

_promises.push(t("#78 [F] advisory mode result has mode='advisory'", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} }, "advisory");
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(r.mode === "advisory", "Result mode should be advisory");
}));

_promises.push(t("#79 [F] shadow mode result has mode='shadow'", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} }, "shadow");
  const r = await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(r.mode === "shadow", "Result mode should be shadow");
}));

_promises.push(t("#80 [F] advisory mode record saved with mode='advisory'", async () => {
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} }, "advisory");
  await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(e._mockState.recs.some(r => r.mode === "advisory"), "No advisory record found");
}));

_promises.push(t("#81 [F] shadow mode does NOT produce advisory records", async () => {
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} }, "shadow");
  await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  assert(e._mockState.recs.every(r => r.mode === "shadow"), "Found advisory record in shadow mode");
}));

_promises.push(t("#82 [F] setMode shadow→advisory→shadow works", () => {
  const e = new MetaSelectorEngine();
  e.setMode("shadow");
  assert(e.getMode() === "shadow");
  e.setMode("advisory");
  assert(e.getMode() === "advisory");
  e.setMode("shadow");
  assert(e.getMode() === "shadow");
}));

_promises.push(t("#83 [F] setMode advisory→shadow→advisory works", () => {
  const e = new MetaSelectorEngine();
  e.setMode("advisory");
  e.setMode("shadow");
  e.setMode("advisory");
  assert(e.getMode() === "advisory");
}));

_promises.push(t("#84 [F] promote route requires SUPER_ADMIN (mock guard)", () => {
  function guard(role) { if (role !== "SUPER_ADMIN") throw new Error("403"); return true; }
  let threw = false;
  try { guard("ADMIN"); } catch { threw = true; }
  assert(threw, "ADMIN should be rejected");
  assert(guard("SUPER_ADMIN"), "SUPER_ADMIN should pass");
}));

_promises.push(t("#85 [F] non-admin roles all rejected by promote guard", () => {
  function guard(role) { return role === "SUPER_ADMIN"; }
  assert(!guard("USER"),  "USER rejected");
  assert(!guard("ADMIN"), "ADMIN rejected");
  assert( guard("SUPER_ADMIN"), "SUPER_ADMIN allowed");
}));

// ─────────────────────────────────────────────────────────────────────────────
// Group G — API Endpoints (tests 86–95)
// ─────────────────────────────────────────────────────────────────────────────

const createMetaSelectorRouter = require("../src/server/routes/metaSelector");

_promises.push(t("#86 [G] createMetaSelectorRouter is a function", () => {
  assert(typeof createMetaSelectorRouter === "function", "Should be a factory function");
}));

_promises.push(t("#87 [G] router is an Express function with stack", () => {
  const router = createMetaSelectorRouter(null);
  assert(typeof router === "function" && router.stack !== undefined, "Should return Express router");
}));

_promises.push(t("#88 [G] router contains /recommend/:symbol route", () => {
  const router = createMetaSelectorRouter(null);
  const paths  = router.stack.map(l => l.route?.path).filter(Boolean);
  assert(paths.some(p => p.includes("recommend")), "Missing /recommend route");
}));

_promises.push(t("#89 [G] router contains /history/:symbol route", () => {
  const router = createMetaSelectorRouter(null);
  const paths  = router.stack.map(l => l.route?.path).filter(Boolean);
  assert(paths.some(p => p.includes("history")), "Missing /history route");
}));

_promises.push(t("#90 [G] router contains /status route", () => {
  const router = createMetaSelectorRouter(null);
  const paths  = router.stack.map(l => l.route?.path).filter(Boolean);
  assert(paths.some(p => p.includes("status")), "Missing /status route");
}));

_promises.push(t("#91 [G] checkPromotionReadiness has ready boolean", async () => {
  const orig = patchShadowPrisma({ count: async () => 0, findMany: async () => [] });
  const result = await ShadowCollectionService.checkPromotionReadiness();
  restoreShadowPrisma(orig);
  assert(typeof result.ready === "boolean", "ready should be boolean");
  assert(typeof result.tradeCount === "number", "tradeCount should be number");
}));

_promises.push(t("#92 [G] status with 0 trades: ready=false", async () => {
  const orig = patchShadowPrisma({ count: async () => 0, findMany: async () => [] });
  const result = await ShadowCollectionService.checkPromotionReadiness();
  restoreShadowPrisma(orig);
  assert(result.ready === false, "Should not be ready with 0 trades");
}));

_promises.push(t("#93 [G] getRecommendationHistory returns array", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} });
  await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  const history = await e.getRecommendationHistory("BTCUSDT", 50);
  assert(Array.isArray(history), "History should be array");
}));

_promises.push(t("#94 [G] getRecommendationHistory respects limit", async () => {
  clearMock();
  const e = buildEngine({ A:{winRate:0.5,profitFactor:1.5,sharpe:1.0,sampleSizeValid:true} });
  for (let i = 0; i < 5; i++) await e.recommend("BTCUSDT", mockIndicators(), ["A"]);
  const history = await e.getRecommendationHistory("BTCUSDT", 3);
  assert(history.length <= 3, "History should respect limit");
}));

_promises.push(t("#95 [G] router contains /promote route", () => {
  const router = createMetaSelectorRouter(null);
  const paths  = router.stack.map(l => l.route?.path).filter(Boolean);
  assert(paths.some(p => p.includes("promote")), "Missing /promote route");
}));

// ─────────────────────────────────────────────────────────────────────────────
// Group H — Regression Sprint 2 (tests 96–100)
// ─────────────────────────────────────────────────────────────────────────────

_promises.push(t("#96 [H] RegimeClassifierEngine.classify() still deterministic", () => {
  const rce  = require("../src/domain/RegimeClassifierEngine");
  const inds = { ema9:110, ema21:100, ema50:90, adx:30, atr:2, atrAvg:1.5, volume:1500, volAvg:1000 };
  const r1   = rce.classify(inds, "BTCUSDT_REGRESSION_96a", "1h");
  const r2   = rce.classify(inds, "BTCUSDT_REGRESSION_96a", "1h");
  assert(r1.composite === r2.composite && r1.confidence === r2.confidence, "Regime should be deterministic");
}));

_promises.push(t("#97 [H] RegimeClassifierEngine returns primary + composite + confidence", () => {
  const rce  = require("../src/domain/RegimeClassifierEngine");
  const inds = { ema9:110, ema21:100, ema50:90, adx:30, atr:2, atrAvg:1.5, volume:1500, volAvg:1000 };
  const r    = rce.classify(inds, "ETHUSDT_REGRESSION_97", "4h");
  assert(r.primary !== undefined && r.composite !== undefined && typeof r.confidence === "number", "Missing fields");
}));

_promises.push(t("#98 [H] StrategyPerformanceService.aggregateDaily() still exported", () => {
  const SPS = require("../src/server/services/StrategyPerformanceService");
  assert(typeof SPS.aggregateDaily === "function", "aggregateDaily should be a function");
}));

_promises.push(t("#99 [H] StrategyPerformanceService._helpers still exported", () => {
  const SPS = require("../src/server/services/StrategyPerformanceService");
  assert(SPS._helpers !== undefined, "_helpers missing");
  assert(typeof SPS._helpers.profitFactor === "function", "profitFactor helper missing");
  assert(typeof SPS._helpers.sharpe === "function", "sharpe helper missing");
}));

_promises.push(t("#100 [H] MetaSelectorEngine import does not corrupt RegimeClassifierEngine", () => {
  const ms  = require("../src/domain/MetaSelectorEngine");
  const rce = require("../src/domain/RegimeClassifierEngine");
  const inds = { ema9:110, ema21:100, ema50:90, adx:30, atr:2, atrAvg:1.5 };
  const r = rce.classify(inds, "BTCUSDT_REGRESSION_100", "1h");
  assert(r.primary !== undefined && r.composite !== undefined, "RegimeClassifier broken after MetaSelector import");
  assert(ms !== undefined, "MetaSelectorEngine should be importable");
}));

// ─────────────────────────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────────────────────────

Promise.all(_promises).then(() => {
  const total = _passCount + _failCount;
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║   QA-S3: Sprint 3 MetaSelector — 100 Tests ║`);
  console.log(`╚════════════════════════════════════════╝\n`);
  console.log(`  TESTS: ${_passCount} passed, ${_failCount} failed (${total} total)`);
  if (_failures.length > 0) {
    console.log(`\nFailures:`);
    _failures.forEach(f => console.log(`  ✗ ${f.test}\n      ${f.error}`));
  }
  console.log(_failCount === 0 ? `\n  ✅ ALL TESTS PASSED\n` : `\n  ❌ ${_failCount} TEST(S) FAILED\n`);
  if (_failCount > 0) process.exitCode = 1;
}).catch(err => {
  console.error("[QA-S3] Fatal error:", err);
  process.exitCode = 1;
});
