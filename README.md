# Quantara — Automated Trading Bot

Bot trading otomatis berbasis **EMA Crossover + RSI Filter + ATR Stop Loss**.
Mendukung **Bitget** (USDT-M Futures) dan **OKX** (Perpetual Swap, termasuk Demo Trading).

---

## Struktur File

```
be-bot-trading/
├── index.js             ← Bot utama (loop trading)
├── backtest.js          ← Script backtest historis
├── exchange-factory.js  ← Pilih exchange dari EXCHANGE env
├── bitget.js            ← Bitget API client
├── okx.js               ← OKX API V5 client
├── indicators.js        ← EMA, RSI, ATR calculator
├── logger.js            ← Logger + Telegram notif
├── .env.example         ← Template konfigurasi
├── .env                 ← Konfigurasi kamu (jangan di-commit!)
└── package.json
```

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Setup konfigurasi
```bash
cp .env.example .env
nano .env   # atau buka dengan text editor
```

**Untuk Bitget**, isi minimal ini di `.env`:
```env
EXCHANGE=bitget
BITGET_API_KEY=bg_xxxxxxxxxxxx
BITGET_SECRET_KEY=xxxxxxxxxxxxxxxxx
BITGET_PASSPHRASE=passwordmu
SYMBOL=BTCUSDT
DRY_RUN=true    # true dulu, false kalau sudah yakin!
```

**Untuk OKX (dengan Demo Trading)**, isi:
```env
EXCHANGE=okx
OKX_API_KEY=xxxxxxxxxxxx
OKX_SECRET_KEY=xxxxxxxxxxxx
OKX_PASSPHRASE=passwordmu
OKX_DEMO_TRADING=true      # Paper trading, aman!
OKX_INST_ID=BTC-USDT-SWAP
DRY_RUN=true
```

### 3. Jalankan backtest dulu
```bash
# Backtest Bitget (default)
node backtest.js

# Backtest OKX (gunakan data live dari API publik OKX)
node backtest.js --exchange okx --symbol BTC-USDT-SWAP
```

Output contoh:
```
  Modal Awal    : $500.00
  Modal Akhir   : $1,247.83
  Total Return  : +149.57%
  CAGR          : 49.2%/tahun
  Max Drawdown  : 18.3%
  Win Rate      : 21.4%
  Profit Factor : 2.87
```

### 4. Jalankan bot (DRY RUN dulu!)
```bash
# Bitget (default)
node index.js

# OKX
EXCHANGE=okx node index.js
```

### 5. Kalau sudah puas dengan hasil, ganti ke live
```env
DRY_RUN=false
OKX_DEMO_TRADING=false   # Khusus OKX: matikan demo jika mau live
```

---

## ⚙️ Konfigurasi Parameter

| Parameter | Default | Penjelasan |
|-----------|---------|------------|
| `EMA_FAST` | 9 | EMA periode pendek (trigger) |
| `EMA_SLOW` | 21 | EMA periode panjang (trend) |
| `RSI_PERIOD` | 14 | Periode RSI |
| `RSI_OVERBOUGHT` | 70 | Filter LONG: jangan beli kalau RSI > ini |
| `ATR_MULTIPLIER` | 2 | Stop Loss = 2 × ATR dari entry |
| `RISK_REWARD` | 3 | Take Profit = 3 × SL distance (R:R 1:3) |
| `RISK_PER_TRADE` | 0.02 | 2% modal per trade |
| `LEVERAGE` | 3 | Leverage futures (hati-hati!) |
| `CANDLE_INTERVAL` | 4H | Timeframe: 1H, 4H, 1D |

---

## 📖 Cara Kerja Strategi

```
BELI (LONG) ketika:
  ✓ EMA(9) memotong ke ATAS EMA(21)  ← Golden Cross
  ✓ RSI < 70                          ← Tidak overbought

JUAL ketika:
  ✓ EMA(9) memotong ke BAWAH EMA(21) ← Death Cross
  ATAU
  ✓ Stop Loss tercapai (2× ATR)
  ATAU
  ✓ Take Profit tercapai (6× ATR)

Position Sizing:
  Ukuran = (Modal × 2%) ÷ (Jarak SL)
  → Selalu risk 2% modal per trade, otomatis
```

---

## Setup API Key

### Bitget
1. Login ke **bitget.com**
2. **User Center → API Management → Create API**
3. Nama: "Quantara" (bebas)
4. Passphrase: buat password tersendiri
5. Permission: **Read** + **Trade** | Withdraw (JANGAN!)
6. IP Whitelist: masukkan IP VPS kamu (lebih aman)
7. Copy **API Key**, **Secret Key**, **Passphrase** ke `.env`

### OKX
1. Daftar / login ke **okx.com**
2. **Profile → API Management → Create V5 API Key**
3. Nama: "Quantara", Passphrase: buat password tersendiri
4. Permission: **Read** + **Trade** | Withdraw (JANGAN!)
5. Untuk Demo Trading: aktifkan **"Demo Trading"** di menu atas OKX sebelum membuat API Key — API key demo hanya berlaku di environment demo
6. Isi `.env`:
```env
EXCHANGE=okx
OKX_API_KEY=...
OKX_SECRET_KEY=...
OKX_PASSPHRASE=...
OKX_DEMO_TRADING=true      # true jika API key dari akun demo
OKX_INST_ID=BTC-USDT-SWAP  # Format: BASE-QUOTE-SWAP
```

> **Catatan OKX**: Simbol berbeda dari Bitget. `BTC-USDT-SWAP` bukan `BTCUSDT`.
> 1 contract BTC-USDT-SWAP = 0.01 BTC. Bot otomatis menghitung `sz` (contracts).

---

## 🖥️ Deploy ke VPS

### Opsi VPS (harga per bulan):
| Provider | Spesifikasi | Harga |
|----------|------------|-------|
| **Contabo** | 4 vCPU, 8GB RAM | ~$7/bln |
| **DigitalOcean** | 1 vCPU, 1GB RAM | ~$6/bln |
| **Vultr** | 1 vCPU, 1GB RAM | ~$5/bln |
| **Hetzner** | 2 vCPU, 4GB RAM | ~€4/bln |
| **RackNerd** | 1 vCPU, 1GB RAM | ~$11/tahun |

**Rekomendasi untuk bot ini: RackNerd atau Hetzner** (paling murah)

### Setup VPS (Ubuntu):
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 (process manager)
sudo npm install -g pm2

# Upload bot ke VPS (dari laptop kamu)
scp -r ./be-bot-trading user@ip-vps:/home/user/

# Di VPS
cd be-bot-trading
npm install
cp .env.example .env
nano .env   # isi API key

# Jalankan dengan PM2 (auto-restart jika crash)
pm2 start index.js --name "quantara"
pm2 save
pm2 startup   # auto-start saat VPS reboot

# Monitor log
pm2 logs quantara
pm2 status
```

---

## 📱 Notifikasi Telegram (Opsional)

1. Chat **@BotFather** di Telegram
2. `/newbot` → beri nama → copy **Token**
3. Chat **@userinfobot** → copy **Chat ID**
4. Isi di `.env`:
```env
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNO
TELEGRAM_CHAT_ID=987654321
```

Bot akan kirim notif setiap kali ada trade terbuka/tertutup.

---

## Backtest Advanced

```bash
# Backtest Bitget ETHUSDT 180 hari dengan parameter custom
node backtest.js --symbol ETHUSDT --days 180 --ema-fast 12 --ema-slow 26

# Backtest OKX menggunakan data live dari API publik OKX
node backtest.js --exchange okx --symbol BTC-USDT-SWAP
node backtest.js --exchange okx --symbol ETH-USDT-SWAP --days 180

# Ekspor hasil ke CSV
node backtest.js --export

# LONG + SHORT
node backtest.js --both-sides true

# Timeframe 1 jam
node backtest.js --interval 1H --days 90
```

---

## ⚠️ DISCLAIMER & RISIKO

- **Backtest bukan jaminan profit.** Pasar masa depan ≠ masa lalu.
- **Mulai kecil.** Test dengan $50–100 dulu sebelum naikkan modal.
- **Leverage = pisau bermata dua.** Leverage 3x berarti drawdown 3x juga.
- **Jaga API key.** Jangan pernah share, jangan aktifkan permission Withdraw.
- **Monitor rutin.** Bot bisa error. Cek setiap hari, terutama minggu pertama.
- **Bot ini bukan financial advice.** Kamu bertanggung jawab atas keputusan trading sendiri.

---

## Troubleshooting

**"Invalid API Key" / "signature invalid"**
→ Pastikan API key, secret, passphrase benar. Tidak ada spasi di .env.
→ OKX: Pastikan API key dibuat di environment yang sesuai (demo vs live).

**"Insufficient balance"**
→ Bitget: Cek saldo USDT di akun Futures (bukan Spot).
→ OKX: Cek saldo di akun Trading (bukan Funding).

**"Bot tidak masuk posisi"**
→ Normal. Strategi EMA hanya entry saat crossover. Bisa beberapa hari/minggu menunggu.

**"Position size terlalu kecil"**
→ Modal terlalu kecil untuk risk 2%. Coba naikkan modal atau naikkan RISK_PER_TRADE ke 0.05.

**OKX: "instId does not exist"**
→ Cek format simbol. Gunakan `BTC-USDT-SWAP` bukan `BTCUSDT`.

**OKX: Demo tidak berfungsi**
→ Pastikan `OKX_DEMO_TRADING=true` dan API key dibuat saat mode demo aktif di website OKX.
