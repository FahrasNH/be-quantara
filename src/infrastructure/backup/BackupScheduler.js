/**
 * BackupScheduler.js — Backup database otomatis tanpa cron.
 * Berjalan di dalam proses Node.js. Dipanggil setelah db.init() berhasil.
 *
 * Yang di-backup:
 *   1. Tabel trades + sessions → CSV (ringan, bisa dibuka Excel)
 *   2. Full pg_dump gzip (untuk restore full)
 *
 * Default: setiap 24 jam, simpan 30 hari terakhir.
 */

const { execSync } = require("child_process");
const path    = require("path");
const fs      = require("fs");
const { Pool } = require("pg");

const BACKUP_DIR     = process.env.BACKUP_DIR     || "/opt/quantara-backups";
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || "30", 10);
const INTERVAL_MS    = parseInt(process.env.BACKUP_INTERVAL_MS    || String(24 * 60 * 60 * 1000), 10); // 24j
const ENABLED        = process.env.BACKUP_ENABLED !== "false";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Helpers ──────────────────────────────────────────────────────────────────

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function log(msg) {
  console.log(`[Backup] ${new Date().toISOString()} ${msg}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function parseDbUrl(url) {
  const u = url.replace(/^(postgresql|postgres):\/\//, "");
  const [userPass, rest]   = u.split("@");
  const [user, pass]       = userPass.split(":");
  const [hostPort, dbFull] = rest.split("/");
  const [host, port = "5432"] = hostPort.split(":");
  const db = dbFull.split("?")[0];
  return { user, pass, host, port, db };
}

// ── CSV export via pg COPY ───────────────────────────────────────────────────

async function exportCSV(filepath, query) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(query);
    if (rows.length === 0) {
      fs.writeFileSync(filepath, "no data\n");
      return 0;
    }
    const headers = Object.keys(rows[0]).join(",");
    const lines   = rows.map(r =>
      Object.values(r).map(v =>
        v === null ? "" : String(v).includes(",") ? `"${v}"` : String(v)
      ).join(",")
    );
    fs.writeFileSync(filepath, `${headers}\n${lines.join("\n")}\n`);
    return rows.length;
  } finally {
    client.release();
  }
}

// ── pg_dump (optional — skip jika pg_dump tidak tersedia) ───────────────────

function pgDump(filepath) {
  const { user, pass, host, port, db } = parseDbUrl(process.env.DATABASE_URL || "");
  const env = { ...process.env, PGPASSWORD: pass };
  try {
    execSync(
      `pg_dump -h ${host} -p ${port} -U ${user} ${db} | gzip > ${filepath}`,
      { env, stdio: ["ignore", "pipe", "pipe"] }
    );
    return true;
  } catch {
    return false; // pg_dump mungkin tidak tersedia di env ini
  }
}

// ── Cleanup backup lama ──────────────────────────────────────────────────────

function cleanup() {
  try {
    const files = fs.readdirSync(BACKUP_DIR);
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let deleted = 0;
    for (const f of files) {
      if (f === "latest.sql.gz" || f.startsWith("trades_latest") || f.startsWith("sessions_latest")) continue;
      const fp = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        deleted++;
      }
    }
    if (deleted > 0) log(`Cleanup: ${deleted} file lama dihapus (> ${RETENTION_DAYS} hari)`);
  } catch { /* best effort */ }
}

// ── Backup utama ──────────────────────────────────────────────────────────────

async function runBackup() {
  if (!ENABLED) return;

  try {
    ensureDir(BACKUP_DIR);
    const ts = timestamp();
    log(`Mulai backup → ${BACKUP_DIR}`);

    // 1. CSV trades (paling penting — data finansial)
    const tradesCsv = path.join(BACKUP_DIR, `trades_${ts}.csv`);
    const tradeCount = await exportCSV(tradesCsv,
      `SELECT t.id, t.session_id, s.user_id, t.exchange, t.symbol, t.side,
              t.entry_price, t.exit_price, t.sl, t.tp, t.size, t.pnl, t.pnl_pct,
              t.reason, t.open_time, t.close_time, t.dry_run, t.order_id
       FROM trades t
       LEFT JOIN bot_sessions s ON s.id = t.session_id
       ORDER BY t.open_time DESC`
    );
    log(`  trades CSV    : ${tradesCsv} (${tradeCount} baris)`);

    // Symlink → trades_latest.csv
    const latestTrades = path.join(BACKUP_DIR, "trades_latest.csv");
    try { fs.unlinkSync(latestTrades); } catch {}
    fs.symlinkSync(tradesCsv, latestTrades);

    // 2. CSV sessions
    const sessionsCsv = path.join(BACKUP_DIR, `sessions_${ts}.csv`);
    const sessionCount = await exportCSV(sessionsCsv,
      `SELECT id, user_id, exchange, symbol, mode, initial_capital, final_capital,
              total_trades, wins, losses, started_at, stopped_at
       FROM bot_sessions ORDER BY started_at DESC`
    );
    log(`  sessions CSV  : ${sessionsCsv} (${sessionCount} baris)`);

    // 3. pg_dump (jika pg_dump tersedia)
    const dumpFile = path.join(BACKUP_DIR, `quantara_${ts}.sql.gz`);
    const dumpOk   = pgDump(dumpFile);
    if (dumpOk) {
      const sizeMB = (fs.statSync(dumpFile).size / 1024 / 1024).toFixed(2);
      log(`  pg_dump       : ${dumpFile} (${sizeMB} MB)`);
      const latestDump = path.join(BACKUP_DIR, "latest.sql.gz");
      try { fs.unlinkSync(latestDump); } catch {}
      fs.symlinkSync(dumpFile, latestDump);
    } else {
      log(`  pg_dump       : skip (pg_dump tidak tersedia — CSV tetap ada)`);
    }

    // 4. Cleanup
    cleanup();

    log(`Backup selesai ✅`);
  } catch (err) {
    log(`ERROR: ${err.message}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

let _timer = null;

function start() {
  if (!ENABLED) {
    console.log("[Backup] Dinonaktifkan (BACKUP_ENABLED=false)");
    return;
  }

  // Backup pertama kali: 5 menit setelah server start (tidak langsung agar tidak
  // membebani startup)
  setTimeout(async () => {
    await runBackup();
    // Lanjut tiap INTERVAL_MS
    _timer = setInterval(runBackup, INTERVAL_MS);
  }, 5 * 60 * 1000);

  const intervalHours = (INTERVAL_MS / 3_600_000).toFixed(1);
  console.log(`[Backup] Terjadwal setiap ${intervalHours} jam → ${BACKUP_DIR} (retain ${RETENTION_DAYS} hari)`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/** Backup manual — bisa dipanggil dari endpoint admin */
async function backupNow() {
  await runBackup();
}

module.exports = { start, stop, backupNow };
