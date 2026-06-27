# Grok AI Live Trading — Dokumentasi Implementasi

**Proyek:** Quantara (`be-bot-trading` + `fe-bot-trading`)  
**Versi dokumen:** 1.1  
**Tanggal:** Juni 2026  
**Status:** Proposal implementasi  

---

## 1. Ringkasan

Dokumen ini mencakup **dua mode** integrasi Grok (xAI) di Quantara:

| Mode | Strategi | Peran Grok |
|------|----------|------------|
| **A. GROK_AI_TRADING** | Strategi standalone | Entry + confidence + TP/SL **100% dari Grok** |
| **B. GROK_CONFIRM (Mode C)** | AF / TM / MR / BR | Rules fire dulu → Grok **konfirmasi entry** + **adjust TP**; **SL tetap rules** |

### Mode A — Grok AI Trading (full)

- Arah entry (`LONG` / `SHORT`) — **confidence ≥ 8**
- **Take Profit** & **Stop Loss** dari Grok — **confidence ≥ 7**
- Aksi posisi terbuka (`CLOSE` / `HOLD`)

### Mode B — Grok Confirm Gate + TP Adjust (Mode C) ✅ disetujui

- **AF / TM / MR / BR** menghasilkan sinyal + **SL/TP baseline dari rules** (ATR×mult)
- **SL tidak pernah dari Grok** — risk management tetap deterministik
- Grok dipanggil **1× per sinyol** (prompt lite) untuk:
  - Konfirmasi arah (`confirm_entry`, confidence ≥ 8)
  - **Adjust TP** dalam band aman (`suggested_tp`, `tp_confidence` ≥ 7)
- Jika Grok menolak TP rules → skip trade atau pakai TP rules (kebijakan `GROK_CONFIRM_TP_REJECT_ACTION`)

Pola Mode A mengacu bot **DeepSeek Scalping** (`Binance-Futures-Scalping-Bot/multitimeframe.py`). Mode B memperkuat strategi rule-based existing tanpa menggantinya.

### Perbedaan dengan Grok saat ini

| Fitur | Grok saat ini (`XaiTrainingService`) | Mode A (full AI) | Mode B (Confirm + TP adjust) |
|-------|--------------------------------------|------------------|------------------------------|
| Dipakai saat | Setelah backtest / Optimasi | Setiap siklus bot live | Hanya saat AF/TM/MR/BR fire |
| Output | Skor + saran parameter | Trade + TP/SL penuh | Confirm + suggested TP |
| SL sumber | — | Grok | **Rules (fixed)** |
| TP sumber | — | Grok | **Rules baseline → Grok adjust** |
| Engine | `OptimizationAnalysisService` | `BotEngine._tickGrokAi()` | `BotEngine` setelah `detectSignal()` |
| Token/call | Rendah | Tinggi (multi-TF) | **Rendah (prompt lite)** |

---

## 2. Tujuan & Non-Tujuan

### Tujuan

- Strategi **`GROK_AI_TRADING`** (Mode A) terdaftar di `StrategyRegistry`
- **Mode B (`GROK_CONFIRM`)** — layer konfirmasi + TP adjust untuk AF/TM/MR/BR
- Bot live memanggil Grok (prompt sesuai mode: full vs lite)
- Parse respons JSON → validasi → eksekusi dengan SL rules + TP final
- Log interaksi AI (audit trail) ke DB / file
- Mode **dry-run / paper** sebelum live

### Non-Tujuan (fase 1)

- Backtest engine frontend 100% identik dengan keputusan Grok (LLM non-deterministik)
- Fine-tuning model Grok
- Mengganti 4 strategi rule-based — Mode B **melengkapi**, bukan mengganti
- Grok menentukan **SL** di Mode B (tetap rules)

---

## 3. Arsitektur Target

### 3.1 Mode A — GROK_AI_TRADING (full)

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────┐
│  BotEngine      │────▶│ GrokTradingService   │────▶│  XaiClient  │
│  _tick()        │     │ formatPrompt()       │     │  chat()     │
│                 │◀────│ parseTradeResponse() │◀────│  JSON mode  │
└────────┬────────┘     └──────────────────────┘     └─────────────┘
         │
         ▼
┌─────────────────┐
│ Exchange Client │  MARKET entry + TP/SL orders
│ (Bitget)        │
└─────────────────┘
```

### Alur siklus (setiap `checkInterval`)

1. Fetch candles multi-TF (1m, 5m, 15m, 30m, 1h, 4h)
2. Hitung indikator (`calcEMA`, `calcRSI`, `calcMACD`, `calcATR`)
3. Kumpulkan open interest & funding rate (opsional fase 2)
4. Format prompt → panggil Grok (`jsonMode: true`)
5. Parse JSON → validasi confidence (entry ≥ 8, TP/SL ≥ 7), R:R minimum
6. Eksekusi trade atau kelola posisi existing
7. Simpan log ke `ai_trade_interactions` / `bot_logs`

### 3.2 Mode B — GROK_CONFIRM + TP Adjust (Mode C)

```
AF / TM / MR / BR
    detectSignal() → LONG | SHORT
    calculateRiskConfig() → SL_rules, TP_rules (ATR×mult)
         │
         ▼ (hanya jika sinyol lolos filter HTF, churn, dll.)
GrokConfirmService.requestConfirmation()
    prompt LITE (~500 token input)
         │
         ▼
Grok JSON: confirm_entry, confidence, suggested_tp, tp_confidence
         │
         ├─ confidence < 8 ──► SKIP (no entry)
         ├─ tp rejected ─────► SKIP atau TP_rules (config)
         └─ OK ─────────────► entry MARKET
                              SL = SL_rules (fixed)
                              TP = suggested_tp ?? TP_rules (clamp band)
```

**Prinsip Mode C:**

| Elemen | Sumber | Grok boleh ubah? |
|--------|--------|------------------|
| Arah (LONG/SHORT) | Rules | Hanya **veto/confirm** (bukan generate) |
| **Stop Loss** | Rules (`calculateRiskConfig`) | **Tidak** |
| **Take Profit** | Rules baseline | **Ya**, dalam band (lihat §18.4) |
| Position size | Rules | Tidak |
| Entry timing | Rules + BotEngine | Tidak |

---

## 4. Prasyarat

### 4.1 Environment (sudah ada sebagian)

Tambahkan ke `be-bot-trading/.env`:

```env
# Grok — sudah dipakai optimizer
XAI_ENABLED=true
XAI_API_KEY="xai-..."
XAI_MODEL="grok-4.3"
XAI_TIMEOUT_MS=60000

# Baru — live trading AI
GROK_TRADING_ENABLED=true
GROK_TRADING_MIN_CONFIDENCE_ENTRY=8
GROK_TRADING_MIN_CONFIDENCE_TP_SL=7
GROK_TRADING_MAX_TOKENS=2000
GROK_TRADING_TEMPERATURE=0.3
GROK_TRADING_CYCLE_MS=600000
GROK_TRADING_DRY_RUN=true
GROK_TRADING_LOG_INTERACTIONS=true

# Mode B — Grok Confirm Gate + TP Adjust (AF/TM/MR/BR)
GROK_CONFIRM_ENABLED=true
GROK_CONFIRM_MIN_CONFIDENCE_ENTRY=8
GROK_CONFIRM_MIN_TP_CONFIDENCE=7
GROK_CONFIRM_TP_ADJUST_BAND_PCT=15
GROK_CONFIRM_TP_MAX_ATR_MULT=0.5
GROK_CONFIRM_TP_REJECT_ACTION=skip
GROK_CONFIRM_FAIL_MODE=closed
GROK_CONFIRM_PROMPT_LITE=true
GROK_CONFIRM_OPEN=true
```

Update `src/config/env.js`:

```javascript
GROK_TRADING_ENABLED:       process.env.GROK_TRADING_ENABLED === "true",
GROK_TRADING_MIN_CONFIDENCE_ENTRY: parseInt(process.env.GROK_TRADING_MIN_CONFIDENCE_ENTRY, 10) || 8,
GROK_TRADING_MIN_CONFIDENCE_TP_SL: parseInt(process.env.GROK_TRADING_MIN_CONFIDENCE_TP_SL, 10) || 7,
GROK_TRADING_MAX_TOKENS:    parseInt(process.env.GROK_TRADING_MAX_TOKENS, 10) || 2000,
GROK_TRADING_TEMPERATURE:   parseFloat(process.env.GROK_TRADING_TEMPERATURE) || 0.3,
GROK_TRADING_CYCLE_MS:      parseInt(process.env.GROK_TRADING_CYCLE_MS, 10) || 600_000,
GROK_TRADING_DRY_RUN:       process.env.GROK_TRADING_DRY_RUN !== "false",
GROK_TRADING_LOG_INTERACTIONS: process.env.GROK_TRADING_LOG_INTERACTIONS !== "false",

// Mode B — Grok Confirm + TP Adjust
GROK_CONFIRM_ENABLED:              process.env.GROK_CONFIRM_ENABLED === "true",
GROK_CONFIRM_MIN_CONFIDENCE_ENTRY: parseInt(process.env.GROK_CONFIRM_MIN_CONFIDENCE_ENTRY, 10) || 8,
GROK_CONFIRM_MIN_TP_CONFIDENCE:    parseInt(process.env.GROK_CONFIRM_MIN_TP_CONFIDENCE, 10) || 7,
GROK_CONFIRM_TP_ADJUST_BAND_PCT:   parseFloat(process.env.GROK_CONFIRM_TP_ADJUST_BAND_PCT) || 15,
GROK_CONFIRM_TP_MAX_ATR_MULT:      parseFloat(process.env.GROK_CONFIRM_TP_MAX_ATR_MULT) || 0.5,
GROK_CONFIRM_TP_REJECT_ACTION:     process.env.GROK_CONFIRM_TP_REJECT_ACTION || "skip",
GROK_CONFIRM_FAIL_MODE:            process.env.GROK_CONFIRM_FAIL_MODE || "closed",
GROK_CONFIRM_PROMPT_LITE:          process.env.GROK_CONFIRM_PROMPT_LITE !== "false",
GROK_CONFIRM_OPEN:                 process.env.GROK_CONFIRM_OPEN === "true",
```

### 4.2 Tier & akses

- Production: batasi tier **VAULT** (mirip `XaiTrainingService.canUseAiOptimizer`)
- Dev: flag `GROK_TRADING_OPEN=true` (mirror `XAI_OPTIMIZER_OPEN`)

---

## 5. Struktur File Baru

```
be-bot-trading/
├── src/
│   ├── domain/
│   │   └── strategy/
│   │       └── implementations/
│   │           └── GrokAiTradingStrategy.js    # StrategyBase wrapper
│   ├── server/
│   │   └── services/
│   │       ├── GrokTradingService.js         # Mode A: prompt, parse, validate
│   │       ├── GrokTradingPromptBuilder.js   # Mode A: multi-TF prompt
│   │       ├── GrokConfirmService.js           # Mode B: confirm + TP adjust
│   │       └── GrokConfirmPromptBuilder.js   # Mode B: prompt lite
│   ├── application/
│   │   └── GrokBotEngineMixin.js             # Opsional: hook di BotEngine
│   └── infrastructure/
│       └── xai/
│           └── XaiClient.js                  # Sudah ada — reuse chat()
├── docs/
│   └── GROK_LIVE_TRADING.md                  # Dokumen ini
└── test/
    ├── grok-trading.test.js
    └── grok-confirm.test.js
```

---

## 6. Strategi: `GrokAiTradingStrategy.js`

Implementasi `StrategyBase` — **delegasi ke Grok**, bukan rumus EMA.

```javascript
// src/domain/strategy/implementations/GrokAiTradingStrategy.js

const StrategyBase = require("../base/StrategyBase");
const GrokTradingService = require("../../../server/services/GrokTradingService");

class GrokAiTradingStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "GROK_AI_TRADING",
      label: "Grok AI Trading",
      description: "Entry, confidence, TP/SL ditentukan Grok (xAI) dari data multi-TF.",
      version: "1.0.0",
      ...config,
    });
    this._lastDecision = null;
  }

  /**
   * detectSignal — untuk BotEngine compatibility.
   * Memanggil Grok secara async; BotEngine perlu path khusus (lihat §8).
   */
  async detectSignalAsync(ctx) {
    const decision = await GrokTradingService.requestTradeDecision(ctx);
    this._lastDecision = decision;
    const minEntry = ctx.minConfidenceEntry ?? ctx.minConfidence ?? 8;
    if (!decision || decision.confidence < minEntry) return null;
    return decision.side; // "LONG" | "SHORT"
  }

  getLastDecision() {
    return this._lastDecision;
  }

  getRiskConfig() {
    return {
      riskPerTrade: 0.01,
      maxTradesPerDay: 20,
      cooldownAfterLoss: 30,
      leverage: 2,
      minConfidenceEntry: 8,
      minConfidenceTpSl: 7,
    };
  }

  getTimeframeConfig() {
    return {
      interval: "15m",
      higherTf: "1h",
      checkInterval: 600_000,
      multiTimeframes: ["1m", "5m", "15m", "30m", "1h", "4h"],
    };
  }

  rankByMarketConditions() { return 50; }
  canActivate(balance) {
    if (balance < 20) return { allowed: false, reason: "Min balance $20" };
    return { allowed: true, reason: "OK" };
  }
}

module.exports = GrokAiTradingStrategy;
```

Daftarkan di `StrategyRegistry.js`:

```javascript
const GrokAiTradingStrategy = require("./implementations/GrokAiTradingStrategy");
this.register("GROK_AI_TRADING", new GrokAiTradingStrategy());
```

---

## 7. GrokTradingService

### 7.1 System prompt

```javascript
const SYSTEM_PROMPT = `You are an expert crypto futures scalper on Bitget USDT-M perpetuals.
Analyze multi-timeframe indicator data and return ONLY valid JSON.
Be conservative: skip trades when timeframes conflict or volatility is too low.
Never invent prices — TP/SL must be realistic relative to current_price and ATR.
Confidence rules: only recommend entry (LONG/SHORT) when confidence >= 8; include take_profit/stop_loss when confidence >= 7.`;
```

### 7.2 Format respons JSON (wajib)

```json
{
  "trades": [
    {
      "symbol": "BTCUSDT",
      "side": "LONG",
      "entry": "MARKET",
      "take_profit": 98500.0,
      "stop_loss": 97000.0,
      "confidence": 8,
      "reasoning": "1m RSI recovery + 5m/15m EMA bullish + 1h trend up"
    }
  ],
  "position_actions": [
    {
      "symbol": "ETHUSDT",
      "action": "CLOSE",
      "reasoning": "Momentum fading, take profit before reversal"
    }
  ]
}
```

Jika tidak ada setup:

```json
{ "trades": [], "position_actions": [] }
```

### 7.3 Ambang confidence (dua tier)

| Tier | Ambang | Dipakai untuk |
|------|--------|---------------|
| **Entry** | `confidence ≥ 8` | Buka posisi baru (`LONG` / `SHORT`) |
| **TP/SL** | `confidence ≥ 7` | Terima & pasang `take_profit` / `stop_loss` dari Grok |

Aturan gabungan:

- `confidence < 7` → tolak seluruh sinyal (tidak entry, TP/SL tidak dipakai)
- `7 ≤ confidence < 8` → TP/SL valid untuk evaluasi posisi terbuka / `position_actions`, **tidak** buka entry baru
- `confidence ≥ 8` → entry + TP/SL dieksekusi penuh

### 7.4 Validasi setelah parse

| Rule | Aksi jika gagal |
|------|-----------------|
| `confidence` 1–10, ≥ `minConfidenceTpSl` (7) untuk TP/SL | Reject TP/SL |
| `confidence` 1–10, ≥ `minConfidenceEntry` (8) untuk entry | Skip entry |
| `side` ∈ {LONG, SHORT} | Reject |
| LONG: `stop_loss < entry < take_profit` | Reject |
| SHORT: `take_profit < entry < stop_loss` | Reject |
| Jarak SL ≥ `atrMinMult × ATR` | Reject (anti-SL terlalu ketat) |
| Reward/risk ≥ `minRiskReward` (default 1.2) | Reject |
| Symbol = bot symbol aktif | Reject cross-symbol salah |
| Posisi sudah ada di symbol | Skip (no double entry) |

### 7.5 Contoh implementasi inti

```javascript
// src/server/services/GrokTradingService.js

const XaiClient = require("../../infrastructure/xai/XaiClient");
const GrokTradingPromptBuilder = require("./GrokTradingPromptBuilder");
const cfg = require("../../config/env");

class GrokTradingService {
  static client = new XaiClient();

  static async requestTradeDecision(ctx) {
    if (!cfg.GROK_TRADING_ENABLED || !this.client.isConfigured) {
      throw new Error("Grok trading tidak aktif atau XAI_API_KEY kosong");
    }

    const userPrompt = GrokTradingPromptBuilder.build(ctx);
    const raw = await this.client.chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      {
        jsonMode: true,
        temperature: cfg.GROK_TRADING_TEMPERATURE,
        maxTokens: cfg.GROK_TRADING_MAX_TOKENS,
      }
    );

    const parsed = this._parseResponse(raw);
    const trade = parsed.trades?.find(t => t.symbol === ctx.symbol);
    if (!trade) return null;

    const validated = this._validateTrade(trade, ctx);
    await this._logInteraction(ctx, userPrompt, raw, validated);
    return validated;
  }

  static _parseResponse(raw) {
    const data = JSON.parse(raw);
    if (!Array.isArray(data.trades)) data.trades = [];
    if (!Array.isArray(data.position_actions)) data.position_actions = [];
    return data;
  }

  // _validateTrade() — cek entry ≥ 8, TP/SL ≥ 7 (lihat §7.3–7.4)
  // _logInteraction()
}

module.exports = GrokTradingService;
```

---

## 8. Integrasi BotEngine

### 8.1 Branch khusus di `_tick()`

Di `BotEngine.js`, sebelum pemanggilan `detectSignal()` rule-based:

```javascript
if (this.config.strategyKey === "GROK_AI_TRADING") {
  await this._tickGrokAi(price, indicators, lastIdx, htfCandlesCache);
  return;
}
```

### 8.2 Method `_tickGrokAi()`

```javascript
async _tickGrokAi(price, indicators, lastIdx, htfCandlesCache) {
  // 1. Kelola posisi terbuka dulu (position_actions)
  if (this.state.openPosition) {
    const action = await GrokTradingService.requestPositionAction({
      symbol: this.config.symbol,
      position: this.state.openPosition,
      indicators,
      htfCandles: htfCandlesCache,
    });
    if (action?.action === "CLOSE") {
      await this._closePosition("GROK_AI_DECISION");
      return;
    }
  }

  // 2. Cari entry baru
  if (this.state.openPosition) return;

  const decision = await GrokTradingService.requestTradeDecision({
    symbol: this.config.symbol,
    price,
    indicators,
    lastIdx,
    htfCandles: htfCandlesCache,
    account: { balance: this.state.capital, openPositions: [] },
    minConfidenceEntry: this.config.minConfidenceEntry ?? cfg.GROK_TRADING_MIN_CONFIDENCE_ENTRY,
    minConfidenceTpSl: this.config.minConfidenceTpSl ?? cfg.GROK_TRADING_MIN_CONFIDENCE_TP_SL,
    atr: indicators.atr[lastIdx],
  });

  if (!decision || decision.confidence < (this.config.minConfidenceEntry ?? 8)) return;
  // TP/SL Grok dipakai hanya jika confidence ≥ minConfidenceTpSl (7); otomatis terpenuhi saat entry ≥ 8

  if (cfg.GROK_TRADING_DRY_RUN) {
    this._log("info", `[GROK DRY-RUN] ${decision.side} conf=${decision.confidence} TP=${decision.take_profit} SL=${decision.stop_loss}`);
    return;
  }

  await this._openPositionWithExplicitTpSl(decision);
}
```

### 8.4 Hook Mode B — setelah `filteredSignal` (AF/TM/MR/BR)

Di `BotEngine.js`, **setelah** STEP 3b (anti-churn), **sebelum** `_openPosition`:

```javascript
if (
  filteredSignal &&
  cfg.GROK_CONFIRM_ENABLED &&
  this.config.strategyKey !== "GROK_AI_TRADING"
) {
  const slDist = signalOptions.slDist;
  const tpDist = signalOptions.tpDist;
  const slPrice = filteredSignal === "LONG" ? price - slDist : price + slDist;
  const tpRules = filteredSignal === "LONG" ? price + tpDist : price - tpDist;

  const confirm = await GrokConfirmService.requestConfirmation({
    symbol: this.config.symbol,
    strategyKey: this.config.strategyKey,
    side: filteredSignal,
    price,
    atr: indicators.atr[lastIdx],
    sl_rules: slPrice,
    tp_rules: tpRules,
    indicatorSnapshot,
    htfTrend: this.state.htfTrend,
    minConfidenceEntry: cfg.GROK_CONFIRM_MIN_CONFIDENCE_ENTRY,
    minTpConfidence: cfg.GROK_CONFIRM_MIN_TP_CONFIDENCE,
  });

  if (!confirm?.confirm_entry || confirm.confidence < cfg.GROK_CONFIRM_MIN_CONFIDENCE_ENTRY) {
    this._log("info", `[GROK CONFIRM] REJECT entry — conf ${confirm?.confidence ?? 0}/10`);
    filteredSignal = null;
  } else if (!confirm.tp_approved && cfg.GROK_CONFIRM_TP_REJECT_ACTION === "skip") {
    this._log("info", `[GROK CONFIRM] REJECT TP — ${confirm.tp_reasoning ?? "not approved"}`);
    filteredSignal = null;
  } else {
    const finalTp = GrokConfirmService.resolveTakeProfit({
      tpRules,
      suggestedTp: confirm.suggested_tp,
      side: filteredSignal,
      price,
      atr: indicators.atr[lastIdx],
      bandPct: cfg.GROK_CONFIRM_TP_ADJUST_BAND_PCT,
      maxAtrMult: cfg.GROK_CONFIRM_TP_MAX_ATR_MULT,
    });
    signalOptions.tpDist = Math.abs(finalTp - price);
    this._log("info",
      `[GROK CONFIRM] APPROVED ${filteredSignal} conf=${confirm.confidence} | ` +
      `TP rules=${tpRules.toFixed(2)} → final=${finalTp.toFixed(2)} | SL=${slPrice.toFixed(2)} (rules)`
    );
  }
}
```

**Catatan:** `signalOptions.slDist` **tidak diubah** Grok — SL tetap dari rules.

### 8.3 TP/SL eksplisit (Mode A saja)

Bot DeepSeek menempatkan TP/SL dari AI. Quantara perlu method baru:

```javascript
async _openPositionWithExplicitTpSl(decision) {
  const { side, take_profit, stop_loss, confidence, reasoning } = decision;
  // calcPositionSize() existing
  // place market order
  // place stop + take profit orders di exchange
  // simpan metadata: { source: "GROK_AI", confidence, reasoning }
}
```

---

## 9. Prompt Builder (data ke Grok)

Mirror `format_deepseek_prompt()` dari `multitimeframe.py`:

**Input per symbol:**

- `current_price`, EMA20, MACD, RSI7
- Open Interest, Funding Rate
- Series 10 bar terakhir (oldest → newest): price, EMA20, MACD, RSI7/14
- Per timeframe (1m, 5m, 15m, 30m, 1h, 4h): EMA20/50, MACD, RSI14, ATR (4h)
- Account: balance, posisi terbuka, unrealized PnL

**Aturan di prompt:**

- Leverage & position size dari config bot
- Max concurrent positions
- Minimum confidence **8** untuk entry, **7** untuk TP/SL
- Multi-TF alignment wajib disebutkan di reasoning

---

## 10. Frontend (`fe-bot-trading`)

### 10.1 Konstanta strategi

`src/constants/backtestStrategies.js`:

```javascript
USER_STRATEGY_KEYS.push("GROK_AI_TRADING");

BUILTIN_STRATEGIES.GROK_AI_TRADING = {
  key: "GROK_AI_TRADING",
  abbrev: "GA",
  label: "Grok AI Trading",
  description: "Entry, confidence, TP/SL ditentukan Grok (xAI). Live only — backtest proxy terbatas.",
  interval: "15m",
  defaults: {
    capital: 500,
    minConfidenceEntry: 8,
    minConfidenceTpSl: 7,
    leverage: 2,
    riskPerTrade: 0.01,
    maxConcurrentPositions: 5,
    cycleIntervalMinutes: 10,
  },
  paramMeta: [ /* minConfidenceEntry, minConfidenceTpSl, capital, ... */ ],
};
```

### 10.2 UI Bot settings

- Dropdown strategi: tambah **Grok AI Trading**
- Badge: `🤖 Grok Live` saat bot aktif
- Panel log: tampilkan `reasoning` + `confidence` dari respons AI
- Toggle **Dry Run** di settings bot (override env)

### 10.3 Backtest tab

Tampilkan peringatan:

> Strategi Grok AI tidak dapat di-backtest deterministik di engine rule-based. Gunakan **Dry Run live** atau tab Optimasi Grok untuk analisis historis.

Opsional fase 2: replay mode dengan cache respons Grok tersimpan.

---

## 11. Database & Logging

### 11.1 Tabel baru (Prisma)

```prisma
model AiTradeInteraction {
  id          String   @id @default(uuid())
  userId      String
  botId       String?
  symbol      String
  type        String   // NEW_TRADE | POSITION_EVAL | ERROR
  prompt      String   @db.Text
  response    String   @db.Text
  parsed      Json?
  createdAt   DateTime @default(now())
}
```

### 11.2 Bot log

Format log UI:

```
[GROK] LONG BTCUSDT | conf 8/10 | TP 98500 | SL 97000 | 1m RSI + 5m trend align
```

---

## 12. Keamanan & Biaya

| Risiko | Mitigasi |
|--------|----------|
| Respons JSON invalid | `jsonMode` + schema validation + retry 1× |
| Hallucination TP/SL | Validasi R:R + jarak ATR + band % dari harga |
| Rate limit xAI | Cache siklus 10 menit; 1 call per symbol per cycle |
| Biaya API | Log token usage; tier gate VAULT |
| Live tanpa testing | `GROK_TRADING_DRY_RUN=true` default |

Estimasi biaya: ~1 call / 10 menit / bot ≈ 144 call/hari. Monitor di [console.x.ai](https://console.x.ai/).

---

## 13. Testing

### 13.1 Unit test (`test/grok-trading.test.js`)

- Parse JSON valid / invalid / markdown-wrapped
- Validasi LONG/SHORT TP/SL geometry
- Reject entry jika confidence < 8; reject TP/SL jika confidence < 7
- Prompt builder menghasilkan field wajib

### 13.2 Integration test

- Mock `XaiClient.chat()` → respons fixture
- BotEngine dry-run → log tanpa order exchange

### 13.3 Manual QA checklist

- [ ] `GROK_TRADING_DRY_RUN=true` → log sinyal, no order
- [ ] Confidence 5–6 → ditolak (di bawah ambang TP/SL)
- [ ] Confidence 7 → TP/SL valid, **tidak** entry (min entry 8)
- [ ] Confidence 8+ → entry + TP/SL dieksekusi
- [ ] HTF bearish + LONG → validasi internal / Grok skip
- [ ] Posisi 10+ menit → `position_actions` dievaluasi
- [ ] TP/SL hit → posisi close normal
- [ ] `ai_trade_interactions` tersimpan

---

## 14. Roadmap Implementasi

| Fase | Deliverable | Estimasi |
|------|-------------|----------|
| **1** | `GrokTradingService` + prompt builder + parse/validate | 2–3 hari |
| **2** | `GrokAiTradingStrategy` + registry + env config | 1 hari |
| **3** | Hook `BotEngine._tickGrokAi` + dry-run + explicit TP/SL | 2–3 hari |
| **4** | DB logging + UI strategi + badge log | 2 hari |
| **5** | QA dry-run 1–2 minggu → live kecil | ongoing |
| **6** (opsional) | Backtest replay dengan cached Grok responses | 3–5 hari |
| **7** | **Mode B:** `GrokConfirmService` + prompt lite + TP clamp | 2–3 hari |
| **8** | **Mode B:** Hook BotEngine setelah `detectSignal()` AF/TM/MR/BR | 1–2 hari |
| **9** | **Mode B:** QA dry-run + band TP validation tests | 1 minggu |

---

## 15. Parameter Default (referensi bot DeepSeek)

| Parameter | Nilai | Keterangan |
|-----------|-------|------------|
| `minConfidenceEntry` | 8 | Skala 1–10 — wajib untuk buka posisi |
| `minConfidenceTpSl` | 7 | Skala 1–10 — wajib untuk terima TP/SL Grok |
| `leverage` | 2 (Quantara) / 75 (DeepSeek asli) | Quantara lebih konservatif |
| `positionSizePct` | 1% | Dari balance |
| `cycleIntervalMinutes` | 10 | Polling Grok |
| `maxConcurrentPositions` | 5–20 | Sesuaikan tier |
| `indicators.ema` | [20, 50] | Bukan 9/21 |
| `indicators.macd` | 12/26/9 | |
| `indicators.rsi` | [7, 14] | |
| `indicators.atr` | [3, 14] | |
| `timeframes` | 1m, 5m, 15m, 30m, 1h, 4h | |

### Mode B — Grok Confirm + TP Adjust

| Parameter | Default | Keterangan |
|-----------|---------|------------|
| `GROK_CONFIRM_ENABLED` | false | Aktifkan layer untuk AF/TM/MR/BR |
| `GROK_CONFIRM_MIN_CONFIDENCE_ENTRY` | 8 | Konfirmasi entry |
| `GROK_CONFIRM_MIN_TP_CONFIDENCE` | 7 | Konfirmasi / adjust TP |
| `GROK_CONFIRM_TP_ADJUST_BAND_PCT` | 15 | ±% jarak TP–entry |
| `GROK_CONFIRM_TP_MAX_ATR_MULT` | 0.5 | Cap pergeseran TP (× ATR) |
| `GROK_CONFIRM_TP_REJECT_ACTION` | skip | `skip` \| `use_rules_tp` |
| `GROK_CONFIRM_FAIL_MODE` | closed | `closed` \| `open` |
| `GROK_CONFIRM_PROMPT_LITE` | true | Prompt ringkas (hemat token) |

---

## 16. Referensi Kode Existing

| File | Peran |
|------|-------|
| `Binance-Futures-Scalping-Bot/multitimeframe.py` | Referensi prompt & siklus DeepSeek |
| `be-bot-trading/src/infrastructure/xai/XaiClient.js` | HTTP client Grok |
| `be-bot-trading/src/server/services/XaiTrainingService.js` | Pola chat + parse JSON |
| `be-bot-trading/src/application/BotEngine.js` | Hook `_tick()` |
| `be-bot-trading/src/domain/strategy/StrategyRegistry.js` | Registrasi strategi |
| `be-bot-trading/docs/XAI_SETUP.md` | Setup API key Grok |

---

## 17. Checklist Go-Live

1. [ ] `XAI_API_KEY` valid, quota cukup
2. [ ] `GROK_TRADING_DRY_RUN=true` minimal 7 hari
3. [ ] Win rate & R:R dry-run masuk akal
4. [ ] Validasi TP/SL tidak pernah reject > 50% respons
5. [ ] Tier / permission production
6. [ ] `GROK_TRADING_DRY_RUN=false` + modal kecil
7. [ ] Monitoring log + alert Telegram

---

## 18. Grok Confirm Gate — Mode C (TP Adjust)

> **Status:** Disetujui untuk implementasi. Melengkapi AF / TM / MR / BR — bukan menggantikan.

### 18.1 Alur lengkap

```
1. detectSignal()           → LONG | SHORT | null
2. HTF filter, churn, tier  → filteredSignal
3. calculateRiskConfig()    → slDist, tpDist (per strategi / komponen AF)
4. GrokConfirmService       → 1 API call, prompt lite
5. Validasi:
   - confirm_entry && confidence ≥ 8
   - tp_approved && tp_confidence ≥ 7
6. resolveTakeProfit()      → clamp suggested_tp dalam band
7. _openPosition()          → SL_rules + TP_final
```

### 18.2 System prompt (Mode B)

```javascript
const GROK_CONFIRM_SYSTEM_PROMPT = `You are a crypto futures trade confirmer for Bitget USDT-M.
A rule-based strategy has already fired a signal with proposed SL and TP from ATR math.
Your job:
1. Confirm or reject the ENTRY direction (confirm_entry, confidence 1-10).
2. Review the proposed TP — approve it, or suggest a better take_profit within reason.
NEVER change or suggest stop_loss — SL is fixed by the system.
Return ONLY valid JSON per schema.
Entry requires confidence >= 8. TP review requires tp_confidence >= 7.`;
```

### 18.3 Format respons JSON (Mode B)

```json
{
  "confirm_entry": true,
  "confidence": 8,
  "side": "LONG",
  "reasoning": "AF 3/3 votes, HTF bullish, TP below 4h resistance",
  "tp_review": {
    "approved": true,
    "tp_confidence": 8,
    "suggested_tp": 98750.0,
    "tp_reasoning": "Extend TP slightly — momentum strong, resistance at 99000"
  }
}
```

Penolakan entry:

```json
{
  "confirm_entry": false,
  "confidence": 5,
  "side": "LONG",
  "reasoning": "HTF conflict, volume weak vs proposal",
  "tp_review": null
}
```

### 18.4 Band adjust TP (clamp)

Grok boleh menggeser TP, tapi **wajib** dalam band aman:

```javascript
// GrokConfirmService.resolveTakeProfit()

function resolveTakeProfit({ tpRules, suggestedTp, side, price, atr, bandPct, maxAtrMult }) {
  const baseline = tpRules;
  if (suggestedTp == null || !Number.isFinite(suggestedTp)) return baseline;

  const tpDist = Math.abs(baseline - price);
  const bandAbs = tpDist * (bandPct / 100);   // ±15% dari *jarak* TP ke entry, bukan % harga absolut
  const atrCap  = atr * maxAtrMult;

  let lo, hi;
  if (side === "LONG") {
    lo = baseline - Math.min(bandAbs, atrCap);
    hi = baseline + Math.min(bandAbs, atrCap);
    lo = Math.max(lo, price + atr * 0.5);     // TP tetap di atas entry
  } else {
    lo = baseline - Math.min(bandAbs, atrCap);
    hi = baseline + Math.min(bandAbs, atrCap);
    hi = Math.min(hi, price - atr * 0.5);     // TP tetap di bawah entry
  }

  return Math.min(hi, Math.max(lo, suggestedTp));
}
```

| Parameter | Default | Arti |
|-----------|---------|------|
| `GROK_CONFIRM_TP_ADJUST_BAND_PCT` | 15 | Grok boleh geser TP ±15% dari **jarak TP–entry** rules |
| `GROK_CONFIRM_TP_MAX_ATR_MULT` | 0.5 | Cap pergeseran absolut = 0.5× ATR (mana yang lebih kecil vs band%) |

**Contoh LONG:**

- Entry: 97500  
- TP rules: 98500 (jarak +1000)  
- Band 15% → ±150 dari baseline → range TP **98350–98650**  
- Cap ATR: 320 × 0.5 = 160 → efektif ±150 (min dari band vs ATR cap)  
- Grok suggest **98750** → clamp **98650**  
- Grok suggest **98400** → **98400** ✓  

Setelah clamp, **re-validasi R:R ≥ minRiskReward** terhadap SL rules.

### 18.5 Prompt lite (hemat token)

Mode B **tidak** perlu prompt multi-TF penuh. Kirim saja:

```
Strategy: ADAPTIVE_FUSION
Signal: LONG (rules)
Reason: Component B day-trade, votes {A:LONG,B:LONG,C:LONG}, marketCond STRONG_TREND
Price: 97500 | ATR: 320
SL (fixed, rules): 96988 (1.6×ATR)
TP (rules baseline): 98588 (3.4×ATR)
HTF: BULLISH | RSI: 62 | EMA20>EMA50 on 15m
Task: confirm_entry (conf 1-10) + tp_review (approve or suggest_tp, tp_confidence 1-10)
```

Estimasi token:

| | Mode A (full) | Mode B (lite) |
|---|---------------|---------------|
| Input | ~1.500–3.000 | ~400–800 |
| Output | ~150–250 | ~100–180 |
| Call frequency | Tiap cycle | **Hanya saat rules fire** (~5–30/hari) |

**Jangan** buat 2 call terpisah (confirm entry + confirm TP) — **1 call** dengan schema gabungan.

### 18.6 Ambang confidence (Mode B)

| Field | Ambang | Gate |
|-------|--------|------|
| `confidence` | ≥ 8 | Boleh entry |
| `tp_review.tp_confidence` | ≥ 7 | TP adjust / approve |
| `tp_review.approved` | `true` | Pakai suggested_tp atau TP rules |

`GROK_CONFIRM_TP_REJECT_ACTION`:

| Nilai | Perilaku |
|-------|----------|
| `skip` (default) | Tolak seluruh trade jika TP ditolak |
| `use_rules_tp` | Entry jika conf ≥ 8, TP = TP rules (abaikan Grok TP) |

### 18.7 Fail mode API

| `GROK_CONFIRM_FAIL_MODE` | Grok timeout/error |
|--------------------------|---------------------|
| `closed` (default) | Skip trade — aman |
| `open` | Lanjut dengan SL/TP rules saja (dev only) |

### 18.8 Threshold per strategi (opsional)

Override di `legacyStrategies.js` atau tier config:

| Strategi | `minConfidenceEntry` | `minTpConfidence` | Catatan |
|----------|----------------------|-------------------|---------|
| **AF** | 8 | 7 | Sudah selektif (afMinVotes=3) |
| **TM** | 7 | 7 | Sedikit lebih fleksibel |
| **MR** | 8 | 7 | Counter-trend — strict entry |
| **BR** | 8 | 8 | Breakout fake sering — TP strict |

### 18.9 GrokConfirmService — skeleton

```javascript
// src/server/services/GrokConfirmService.js

class GrokConfirmService {
  static async requestConfirmation(ctx) {
    const prompt = GrokConfirmPromptBuilder.build(ctx);
    const raw = await GrokConfirmService._client.chat(
      [
        { role: "system", content: GROK_CONFIRM_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      { jsonMode: true, temperature: 0.2, maxTokens: 1024 }
    );
    const parsed = JSON.parse(raw);
    return GrokConfirmService.validateConfirmation(parsed, ctx);
  }

  static validateConfirmation(data, ctx) {
    const minEntry = ctx.minConfidenceEntry ?? 8;
    const minTp    = ctx.minTpConfidence ?? 7;

    const entryOk = data.confirm_entry === true && data.confidence >= minEntry;
    const tp = data.tp_review || {};
    const tpOk = tp.approved === true && (tp.tp_confidence ?? 0) >= minTp;

    return {
      confirm_entry: entryOk,
      confidence: data.confidence,
      tp_approved: tpOk,
      suggested_tp: tp.suggested_tp ?? null,
      tp_confidence: tp.tp_confidence ?? 0,
      reasoning: data.reasoning,
      tp_reasoning: tp.tp_reasoning ?? "",
      side: data.side,
    };
  }

  static resolveTakeProfit(opts) { /* lihat §18.4 */ }
}

module.exports = GrokConfirmService;
```

### 18.10 Log UI (Mode B)

```
[GROK CONFIRM] AF → LONG approved 8/10 | SL 96988 (rules) | TP 98588→98750 (Grok adjust) | HTF BULLISH
[GROK CONFIRM] TM → LONG rejected 5/10 | reason: volume weak
```

### 18.11 Testing Mode B

**Unit test (`test/grok-confirm.test.js`):**

- [ ] `resolveTakeProfit` clamp LONG/SHORT dalam band
- [ ] Reject `suggested_tp` di luar band → fallback TP rules
- [ ] Entry conf 7 → reject; conf 8 + tp_conf 7 → approve
- [ ] SL dari input **tidak** berubah di output
- [ ] R:R re-check setelah TP adjust

**Manual QA:**

- [ ] AF fire + Grok approve → entry dengan SL rules, TP adjusted
- [ ] Grok reject entry → no order
- [ ] Grok reject TP + `skip` → no order
- [ ] Grok reject TP + `use_rules_tp` → entry dengan TP rules
- [ ] API timeout + fail-closed → no order
- [ ] Dry-run log menampilkan TP rules vs final TP

### 18.12 Frontend

Toggle di Bot Settings (AF/TM/MR/BR):

- ☑ **Grok Confirm Gate** (`GROK_CONFIRM_ENABLED`)
- ☑ **Allow Grok TP Adjust** (Mode C — default on)
- Slider: TP adjust band % (default 15)
- Dropdown: On TP reject → Skip / Use rules TP

Badge log: `[Grok Confirm]` terpisah dari `[Grok Live]`.

---

**Maintainer:** tim Quantara  
**Pertanyaan teknis:** lihat `docs/XAI_SETUP.md` dan issue tracker proyek.
