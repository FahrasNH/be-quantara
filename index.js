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

require("./src/server/app");
