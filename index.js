// ─── index.js ────────────────────────────────────────────────────────────────
// Entry point Quantara BE — muat env lalu jalankan server.
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();

// Crash-visibility: tanpa handler ini, satu unhandledRejection/uncaughtException
// membunuh proses TANPA jejak → terlihat seperti "OOM diam-diam". Log dulu sebelum
// PM2 me-restart, agar akar (crash kode vs OOM) selalu tercatat di err.log.
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason instanceof Error ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err?.stack || err);
});

// Diagnostik memori opsional (MEM_DEBUG=1): cetak rincian heap tiap 30 detik agar
// tren leak terlihat di `pm2 logs` — heapUsed naik = objek JS (ccxt/indikator);
// external/arrayBuffers naik = Buffer (candle/jaringan). Off secara default (murah).
if (process.env.MEM_DEBUG === "1") {
  const mb = (n) => Math.round(n / 1048576) + "M";
  setInterval(() => {
    const m = process.memoryUsage();
    console.log(`[MEM] rss=${mb(m.rss)} heapUsed=${mb(m.heapUsed)} heapTotal=${mb(m.heapTotal)} external=${mb(m.external)} arrayBuffers=${mb(m.arrayBuffers)}`);
  }, 30_000).unref();
}

// PM2 restart budget check (OPS-003): PM2 injects `restart_time` ke env proses.
// Tanpa hook eksternal PM2, kita log + alert Telegram admin saat budget hampir habis.
// max_restarts didefinisikan di ecosystem.config.js (default 10); override via PM2_MAX_RESTARTS.
(function checkPm2RestartBudget() {
  const pmId = process.env.pm_id;
  if (!pmId) return;

  const restartCount = parseInt(process.env.restart_time ?? process.env.RESTART_TIME ?? "0", 10);
  const maxRestarts = parseInt(process.env.PM2_MAX_RESTARTS ?? "10", 10);
  const appName = process.env.name ?? `pm_id:${pmId}`;

  if (restartCount <= 0) return;

  console.log(`[PM2] Restart count: ${restartCount}/${maxRestarts} (app: ${appName})`);

  if (restartCount >= maxRestarts) {
    const msg =
      `PM2 max_restarts TERLAMPAUI (${restartCount}/${maxRestarts}) untuk ${appName}. ` +
      `Proses mungkin TIDAK akan di-restart lagi setelah crash berikutnya — cek logs segera.`;
    console.error(`[PM2] ${msg}`);
    try {
      require("./src/infrastructure/notifications/TelegramNotifier").notifyError(msg);
    } catch { /* notifier opsional */ }
  } else if (restartCount >= maxRestarts - 2) {
    const msg =
      `PM2 restart budget hampir habis: ${restartCount}/${maxRestarts} untuk ${appName}. ` +
      `Investigasi crash-loop sebelum proses berhenti total.`;
    console.warn(`[PM2] ${msg}`);
    try {
      require("./src/infrastructure/notifications/TelegramNotifier").notifyError(msg);
    } catch { /* notifier opsional */ }
  }
})();

require("./src/server/app");
