// ─────────────────────────────────────────────────────────────────────────────
// fee-edge-guards.test.js — Sprint 6 (Fee Drag & Edge Recovery)
//
// FEE-01: anti-chase guard di AdaptiveFusionStrategy.detectSignal — tolak entry
//         saat harga sudah terlalu jauh dari mean (EMA9) relatif ATR (chasing).
// FEE-03: math gate min-edge (reward leg ≥ K× fee roundtrip) — predikat yang
//         dipakai BotEngine._handleSignal dikunci di sini agar konstanta tak
//         berubah diam-diam.
// ─────────────────────────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert");
const AdaptiveFusionStrategy = require("../src/domain/strategy/implementations/AdaptiveFusionStrategy");

const afs = new AdaptiveFusionStrategy();
const N = 30; // lastIdx
const mk = (n, v) => Array(n + 1).fill(v);

// Setup uptrend yang membuat Component A + C sama-sama fire LONG (kuorum 2/3):
// EMA9 > EMA21 (aligned), RSI naik & di 45–65, volume spike. Hanya `close[N]`
// yang divariasikan untuk menguji ekstensi terhadap mean.
function uptrendIndicators(lastClose) {
  const closes = mk(N, 104);
  closes[N] = lastClose;
  const rsi = mk(N, 55);
  rsi[N - 2] = 53; // slope +1.0 (>0.5) → Component A LONG
  // AF-FIX-14: EMA9 must be RISING for A/B LONG to fire (slope filter).
  const emaFastArr = mk(N, 103.4);
  emaFastArr[N] = 103.5; // current EMA9 > previous → rising at lastIdx
  return {
    closes,
    emaFast: emaFastArr, // EMA9, rising at N
    emaSlow: mk(N, 102.5), // EMA21
    emaTrend: mk(N, 101.0), // EMA50
    rsi,
    atr: mk(N, 0.5),
    volumes: mk(N, 200),
    volSMA: mk(N, 100), // volRatio 2.0 ≥ 1.5 → A volOk
  };
}
// v2.5: afMinVotes default 3. Tes anti-chase ini menguji sinyal 2-vote
// (A+C) yang valid, jadi set afMinVotes:2 eksplisit agar tetap LONG.
// volatility 1.5 (> LOW_VOL 1.4 v2.5) supaya bukan DEAD_MARKET.
const cfg = { balance: 500, volatility: 1.5, trend_strength: 0.5, afMinVotes: 2, maxEntryExtensionATR: 1.5 };

test("FEE-01 control: entry dekat mean (ekstensi ≤1.5 ATR) → LONG diterima", () => {
  // close 104 → |104 - 103.5| / 0.5 = 1.0 ≤ 1.5 (explicit cfg)
  const sig = afs.detectSignal(uptrendIndicators(104), N, cfg);
  assert.strictEqual(sig, "LONG");
});

test("FEE-01 anti-chase: entry extended (ekstensi >1.5 ATR) → diblok (null)", () => {
  // close 105 → |105 - 103.5| / 0.5 = 3.0 > 1.5 (chasing) → harus null
  const sig = afs.detectSignal(uptrendIndicators(105), N, cfg);
  assert.strictEqual(sig, null);
});

test("FEE-01: maxEntryExtensionATR bisa di-tune via config (longgar → diterima)", () => {
  // dengan maxExt 4.0, ekstensi 3.0 lolos lagi
  const sig = afs.detectSignal(uptrendIndicators(105), N, { ...cfg, maxEntryExtensionATR: 4.0 });
  assert.strictEqual(sig, "LONG");
});

test("FEE-01: anti-chase tidak mengganggu sinyal yang memang dekat mean", () => {
  // batas tepat: close 104.25 → ekstensi 1.5 (== threshold, tidak >) → diterima
  const sig = afs.detectSignal(uptrendIndicators(104.25), N, cfg);
  assert.strictEqual(sig, "LONG");
});

// ── FEE-03: predikat min-edge gate (sama persis dengan BotEngine._handleSignal) ──
// Tolak bila tpDist/price < minEdgeFeeMultiple × (2 × feeRate).
function passesMinEdge({ tpDist, price, feeRate, minEdgeFeeMultiple }) {
  if (!(minEdgeFeeMultiple > 0) || !(price > 0)) return true;
  const roundtrip = 2 * feeRate;
  return tpDist / price >= minEdgeFeeMultiple * roundtrip;
}

test("FEE-03: TP < 5× fee roundtrip → ditolak", () => {
  // taker 0.06%/sisi → roundtrip 0.12% → min TP 0.6%. TP 0.4% < 0.6% → reject
  const ok = passesMinEdge({ tpDist: 0.4, price: 100, feeRate: 0.0006, minEdgeFeeMultiple: 5 });
  assert.strictEqual(ok, false);
});

test("FEE-03: TP ≥ 5× fee roundtrip → diterima", () => {
  // TP 0.8% > 0.6% → pass
  const ok = passesMinEdge({ tpDist: 0.8, price: 100, feeRate: 0.0006, minEdgeFeeMultiple: 5 });
  assert.strictEqual(ok, true);
});

test("FEE-03: maker fee menurunkan ambang → trade yang sama lolos", () => {
  // maker 0.02%/sisi → roundtrip 0.04% → min TP 0.2%. TP 0.4% lolos (vs reject di taker)
  const ok = passesMinEdge({ tpDist: 0.4, price: 100, feeRate: 0.0002, minEdgeFeeMultiple: 5 });
  assert.strictEqual(ok, true);
});

test("FEE-03: minEdgeFeeMultiple=0 menonaktifkan gate", () => {
  const ok = passesMinEdge({ tpDist: 0.001, price: 100, feeRate: 0.0006, minEdgeFeeMultiple: 0 });
  assert.strictEqual(ok, true);
});

// ── FEE-01b: conviction guards di _resolveSignalConflict ─────────────────────

test("FEE-01b: dissent veto — komponen berlawanan (2 LONG vs 1 SHORT) → null", () => {
  const r = afs._resolveSignalConflict({ A: "LONG", B: "LONG", C: "SHORT" });
  assert.strictEqual(r, null);
});

test("FEE-01b: dissent veto bisa dimatikan (afRejectOnDissent=false) → mayoritas menang", () => {
  const r = afs._resolveSignalConflict({ A: "LONG", B: "LONG", C: "SHORT" }, null, { rejectOnDissent: false });
  assert.strictEqual(r, "LONG");
});

test("FEE-01b: kuorum 2 searah tanpa dissent → diterima", () => {
  const r = afs._resolveSignalConflict({ A: "LONG", B: "LONG" });
  assert.strictEqual(r, "LONG");
});

test("FEE-01b: afMinVotes=3 menuntut unanimitas → 2 suara ditolak", () => {
  const r = afs._resolveSignalConflict({ A: "LONG", B: "LONG" }, null, { minVotes: 3 });
  assert.strictEqual(r, null);
});

// ── FEE-01: anti-chase + afMinVotes lewat config detectSignal (preset AF) ─────

test("FEE-01: anti-chase preset v2.6 (maxEntryExtensionATR 0.7) memblok entry ekstensi 0.8", () => {
  // close 103.9 → |103.9 - 103.5| / 0.5 = 0.8 > 0.7 → diblok
  const sig = afs.detectSignal(uptrendIndicators(103.9), N, { ...cfg, maxEntryExtensionATR: 0.7 });
  assert.strictEqual(sig, null);
  const sigNear = afs.detectSignal(uptrendIndicators(103.85), N, { ...cfg, maxEntryExtensionATR: 0.7 });
  assert.strictEqual(sigNear, "LONG");
});

test("FEE-01: anti-chase legacy (maxEntryExtensionATR 1.0) vs ekstensi 1.4", () => {
  const sig = afs.detectSignal(uptrendIndicators(104.2), N, { ...cfg, maxEntryExtensionATR: 1.0 });
  assert.strictEqual(sig, null);
  const sigDefault = afs.detectSignal(uptrendIndicators(104.2), N, cfg);
  assert.strictEqual(sigDefault, "LONG");
});

test("FEE-01b: afMinVotes=3 lewat config — entry 2-vote (A+C) ditolak", () => {
  assert.strictEqual(afs.detectSignal(uptrendIndicators(104), N, cfg), "LONG");
  assert.strictEqual(afs.detectSignal(uptrendIndicators(104), N, { ...cfg, afMinVotes: 3 }), null);
});

// ── v2.6: strongTrendTPMult & DEAD_MARKET boundary ─────────────────────────

test("v2.6: strongTrendTPMult ×1.8 pada STRONG_TREND — TP distance naik, SL tetap", () => {
  const base = afs.calculateRiskConfig(100, 2, "LONG", "B");
  const strong = afs.calculateRiskConfig(100, 2, "LONG", "B", {
    marketCond: "STRONG_TREND",
    strongTrendTPMult: 1.8,
  });
  assert.strictEqual(base.slDistance, strong.slDistance);
  assert.ok(Math.abs(strong.tpDistance - base.tpDistance * 1.8) < 1e-9);
  assert.strictEqual(strong.strongTrendTPApplied, true);
  assert.strictEqual(base.strongTrendTPApplied, false);
});

test("v2.6: DEAD_MARKET boundary — vol 1.3, trend 0.4 → null", () => {
  const closes = mk(N, 104);
  closes[N] = 104;
  const indicators = {
    closes,
    emaFast: mk(N, 103.5),
    emaSlow: mk(N, 102.5),
    emaTrend: mk(N, 101.0),
    rsi: mk(N, 55),
    atr: mk(N, 0.5),
    volumes: mk(N, 200),
    volSMA: mk(N, 100),
  };
  indicators.rsi[N - 2] = 53;
  const sig = afs.detectSignal(indicators, N, {
    balance: 500,
    volatility: 1.3,
    trend_strength: 0.4,
    afMinVotes: 2,
  });
  assert.strictEqual(sig, null);
});

// ── FEE-02: maker/post-only entry routing + fallback taker ───────────────────
// Uji layer routing openPositionMaker pada BitgetClient dengan exchange palsu —
// memastikan: (1) fill maker penuh, (2) timeout → fallback taker size utuh,
// (3) partial maker → sisa diselesaikan taker (maker_partial). Tanpa jaringan.
const BitgetClient = require("../src/infrastructure/exchange/BitgetClient");

function makerClient(fakeExchange) {
  const c = new BitgetClient("k", "s", "p");
  c.exchange = fakeExchange;
  c.getTicker = async () => ({ bestBid: 99.9, bestAsk: 100.1, last: 100 });
  c._fmtPrice = (_m, p) => p;
  return c;
}
const fastOpts = { fillTimeoutMs: 120, pollIntervalMs: 20, maxRequotes: 1 };

test("FEE-02: post-only fill penuh → entryFill 'maker', tanpa taker", async () => {
  let marketCalls = 0;
  const ex = {
    createOrder: async () => ({ id: "m1", status: "open", filled: 0 }),
    fetchOrder:  async () => ({ id: "m1", status: "closed", filled: 1 }),
    cancelOrder: async () => ({}),
    createMarketOrder: async () => { marketCalls++; return { id: "t1" }; },
  };
  const c = makerClient(ex);
  const res = await c.openPositionMaker("BTCUSDT", "open_long", 1, "USDT", 95, 110, fastOpts);
  assert.strictEqual(res.entryFill, "maker");
  assert.strictEqual(marketCalls, 0);
  assert.strictEqual(res.presetSLTP, false);
});

test("FEE-02: post-only tak ke-fill → fallback taker, size utuh, SL/TP di-embed", async () => {
  let marketCalls = 0;
  const ex = {
    createOrder: async () => ({ id: "m2", status: "open", filled: 0 }),
    fetchOrder:  async () => ({ id: "m2", status: "open", filled: 0 }),
    cancelOrder: async () => ({}),
    createMarketOrder: async (_s, _d, size) => { marketCalls++; return { id: "t2", filled: size }; },
  };
  const c = makerClient(ex);
  const res = await c.openPositionMaker("BTCUSDT", "open_long", 1, "USDT", 95, 110, fastOpts);
  assert.strictEqual(res.entryFill, "taker");
  assert.strictEqual(res.filledMaker, 0);
  assert.strictEqual(marketCalls, 1);
  assert.strictEqual(res.presetSLTP, true); // pure-taker → embed SL/TP atomik
});

test("FEE-02: partial maker fill → sisa via taker (maker_partial), SL/TP terpisah", async () => {
  let marketSize = null;
  const ex = {
    createOrder: async () => ({ id: "m3", status: "open", filled: 0 }),
    fetchOrder:  async () => ({ id: "m3", status: "open", filled: 0.4 }),
    cancelOrder: async () => ({}),
    createMarketOrder: async (_s, _d, size) => { marketSize = size; return { id: "t3", filled: size }; },
  };
  const c = makerClient(ex);
  const res = await c.openPositionMaker("BTCUSDT", "open_long", 1, "USDT", 95, 110, fastOpts);
  assert.strictEqual(res.entryFill, "maker_partial");
  assert.ok(Math.abs(res.filledMaker - 0.4) < 1e-9);
  assert.ok(Math.abs(marketSize - 0.6) < 1e-9); // sisa diselesaikan taker
  assert.strictEqual(res.presetSLTP, false);    // ada porsi maker → BotEngine pasang SL/TP
});
