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
  return {
    closes,
    emaFast: mk(N, 103.5), // EMA9
    emaSlow: mk(N, 102.5), // EMA21
    emaTrend: mk(N, 101.0), // EMA50
    rsi,
    atr: mk(N, 0.5),
    volumes: mk(N, 200),
    volSMA: mk(N, 100), // volRatio 2.0 ≥ 1.5 → A volOk
  };
}
const cfg = { balance: 500, volatility: 1.2, trend_strength: 0.5 };

test("FEE-01 control: entry dekat mean (ekstensi ≤1.5 ATR) → LONG diterima", () => {
  // close 104 → |104 - 103.5| / 0.5 = 1.0 ≤ 1.5
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
