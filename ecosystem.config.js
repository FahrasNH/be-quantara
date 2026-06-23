/**
 * PM2 — production (port 3000) + staging (port 3001)
 *
 * Production (dari folder prod):
 *   pm2 start ecosystem.config.js --only be-quantara-prod
 *
 * Staging (dari /opt/quantara-staging/be-bot-trading):
 *   pm2 start ecosystem.config.js --only be-quantara-staging
 *
 * OPS-003 hardening:
 *  - max_restarts + min_uptime: hentikan crash-loop (mis. env invalid) alih-alih
 *    restart tanpa batas yang membombardir exchange API.
 *  - kill_timeout 30s: beri waktu BotEngine menutup order/posisi in-flight saat
 *    SIGINT sebelum PM2 mengirim SIGKILL — kritikal untuk live trading.
 *  - error_file/out_file: log persisten per-app. Pasang juga pm2-logrotate di VPS:
 *    pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 50M
 */
module.exports = {
  apps: [
    {
      name:          "be-quantara-prod",
      script:        "index.js",
      cwd:           __dirname,
      instances:     1,
      autorestart:   true,
      max_restarts:  10,
      min_uptime:    "30s",
      kill_timeout:  30000,
      // 512M terlalu kecil untuk multi-strategy: tiap bot menjalankan N engine
      // (mis. 9 bot × 4 strategi = 36 BotEngine) + buffer candle/indikator + Prisma
      // + pg pool. Saat lewat batas, PM2 me-restart proses → SEMUA engine in-memory
      // hilang → jendela cold-resume baru → ROI/PnL & posisi "kedip" sampai resume
      // selesai. Naikkan ke 1024M agar siklus OOM-restart ini berhenti. Pastikan VPS
      // punya RAM cukup (≥2GB direkomendasikan untuk prod+staging berdampingan).
      max_memory_restart: "1024M",
      error_file:    "logs/be-quantara-prod.err.log",
      out_file:      "logs/be-quantara-prod.out.log",
      merge_logs:    true,
      time:          true,
      env: {
        NODE_ENV: "production",
        PORT:     3000,
      },
    },
    {
      name:          "be-quantara-staging",
      script:        "index.js",
      cwd:           __dirname,
      instances:     1,
      autorestart:   true,
      max_restarts:  10,
      min_uptime:    "30s",
      kill_timeout:  30000,
      // Lihat catatan pada app prod: 512M memicu siklus OOM-restart yang membuat
      // ROI/PnL & open-position kedip antar refresh. Naikkan ke 1024M.
      max_memory_restart: "1024M",
      error_file:    "logs/quantara-staging.err.log",
      out_file:      "logs/quantara-staging.out.log",
      merge_logs:    true,
      time:          true,
      env: {
        NODE_ENV: "production",
        PORT:     3001,
      },
    },
  ],
};
