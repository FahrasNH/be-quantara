/**
 * PM2 — production (port 3000) + staging (port 3001)
 *
 * Production (dari folder prod):
 *   pm2 start ecosystem.config.js --only be-quantara-prod
 *
 * Staging (dari /opt/quantara-staging/be):
 *   pm2 start ecosystem.config.js --only be-quantara-staging
 *
 * OPS-003 hardening:
 *  - max_restarts + min_uptime: hentikan crash-loop (mis. env invalid) alih-alih
 *    restart tanpa batas yang membombardir exchange API.
 *  - kill_timeout 30s: beri waktu BotEngine menutup order/posisi in-flight saat
 *    SIGINT sebelum PM2 mengirim SIGKILL — kritikal untuk live trading.
 *  - error_file/out_file: log persisten per-app. Pasang juga pm2-logrotate di VPS:
 *    pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 50M
 *
 * PM2 restart monitoring: index.js membaca env `restart_time` (injected PM2) saat boot
 * dan mengirim alert Telegram admin bila mendekati/melewati max_restarts di bawah.
 * Override threshold via PM2_MAX_RESTARTS env (default 10, selaras max_restarts di sini).
 *
 * TODO(P2-13): Bot tick worker process — ekstrak loop per-user dari proses HTTP utama
 * untuk isolasi memory/CPU saat scale 50+ bot. Worker architecture belum diimplementasi.
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
      // 512M/1024M/2560M kurang headroom untuk multi-strategy: tiap bot menjalankan N
      // engine (mis. 10 bot × 4 strategi = 40+ BotEngine) + buffer candle/indikator +
      // Prisma + pg pool. Working-set terukur ~1500M, dengan lonjakan transien saat
      // Start-All/resume. Limit = CEILING KEAMANAN, bukan target: harus di atas
      // working-set+spike TAPI di bawah level yang membuat memory-leak melahap seluruh
      // VPS (yang akan men-OOM-kill Postgres/prod). Di set 3072M: ~2× working-set
      // headroom; SUM prod+staging = 6GB < 7.8GB total, sisakan ~1.8GB utk OS+Postgres.
      // PENTING: VPS ini Swap=0B → lonjakan transien langsung di-kill (tak ada paging).
      // Tambahkan swapfile 4GB di VPS agar spike sesaat ter-page, bukan fatal.
      max_memory_restart: "3072M",
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
      // Lihat catatan pada app prod: working-set multi-strategy ~1500M + spike saat
      // Start-All; limit 1024M→OOM-loop, 2560M masih sesekali kena spike. Set 3072M
      // (RAM VPS 7.8GB). Tambah swapfile 4GB di VPS agar spike transien tak fatal.
      max_memory_restart: "3072M",
      error_file:    "logs/quantara-staging.err.log",
      out_file:      "logs/quantara-staging.out.log",
      merge_logs:    true,
      time:          true,
      env: {
        NODE_ENV: "production",
        PORT:     3001,
        APP_ENV:  "staging",
        RAG_BACKTEST_ENABLED: "true",
        // Profiling heap/RSS tiap 30s di pm2 logs (index.js MEM_DEBUG=1). Matikan di prod.
        BACKTEST_ISOLATE: "1",
        BACKTEST_WORKER_HEAP_MB: "768",
        BACKTEST_MAX_CONCURRENT: "1",
        MEM_DEBUG: "1",
    },
  ],
};
