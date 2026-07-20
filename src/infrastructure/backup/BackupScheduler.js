/**
 * BackupScheduler.js — Backup database otomatis tanpa cron.
 * Berjalan di dalam proses Node.js. Dipanggil setelah db.init() berhasil.
 *
 * Yang di-backup:
 *   1. Tabel trades + sessions → CSV (ringan, bisa dibuka Excel) — SELALU
 *   2. Full pg_dump gzip (untuk restore full) — PROD saja secara default
 *
 * Non-prod (staging/dev) default: CSV-only, retensi 3 hari. Full pg_dump di
 * non-prod adalah biang bloat (72GB — tiap dump menyalin SELURUH DB 2GB), dan
 * CSV trades/sessions sudah cukup untuk keperluan non-prod. Prod tetap full dump.
 *
 * Guardrail berlapis (agar 72GB TIDAK terjadi lagi walau salah satu gagal):
 *   1. cleanup() by-mtime (retensi hari) — selalu di finally.
 *   2. enforceSizeCap() hard-cap total folder — hapus dump tertua sampai < cap.
 *   3. Non-prod skip full dump → volume dump ~0.
 */

const { execSync } = require("child_process");
const path    = require("path");
const fs      = require("fs");
// Reuse the shared engine pool — a second Pool() here silently added another
// default-10 connections and competed with live bot ticks under load.
const { _pool: pool } = require("../db/database");

// Prod app (ecosystem) tidak set APP_ENV; staging="staging", dev="development".
const APP_ENV = (process.env.APP_ENV || "").toLowerCase();
const IS_PROD = APP_ENV === "" || APP_ENV === "production" || APP_ENV === "prod";

const BACKUP_DIR     = process.env.BACKUP_DIR     || "/opt/quantara-backups";
// Retensi: prod 7 hari, non-prod 3 hari. Override via BACKUP_RETENTION_DAYS.
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || (IS_PROD ? "7" : "3"), 10);
const INTERVAL_MS    = parseInt(process.env.BACKUP_INTERVAL_MS    || String(24 * 60 * 60 * 1000), 10); // 24j
const ENABLED        = process.env.BACKUP_ENABLED !== "false";
// Full pg_dump: default ON di prod, OFF di non-prod (biang 72GB bloat).
// Paksa nyalakan/matikan via BACKUP_FULL_DUMP=true|false.
const FULL_DUMP      = process.env.BACKUP_FULL_DUMP != null
  ? process.env.BACKUP_FULL_DUMP !== "false"
  : IS_PROD;
// Hard-cap total ukuran folder backup (GB). Guardrail terakhir bila cleanup gagal.
const MAX_DIR_GB     = parseFloat(process.env.BACKUP_MAX_DIR_GB || (IS_PROD ? "40" : "5"));
// Minimal dump yang SELALU dipertahankan (restore point) walau melewati cap/retensi.
const KEEP_MIN       = parseInt(process.env.BACKUP_KEEP_MIN || "2", 10);

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
// Aggressive cleanup — silently skipping here caused 72GB bloat. Now with logging
// so ops can debug. Skips "latest" symlinks; purges everything older than cutoff.

function cleanup() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0, errors = [];

  try {
    const files = fs.readdirSync(BACKUP_DIR);
    log(`[Cleanup] scanning ${files.length} files (retention=${RETENTION_DAYS}d)`);

    for (const f of files) {
      // Skip "latest" symlinks (point to current backup, re-created each run)
      if (f === "latest.sql.gz" || f.startsWith("trades_latest") || f.startsWith("sessions_latest")) {
        continue;
      }

      try {
        const fp = path.join(BACKUP_DIR, f);
        const stat = fs.statSync(fp);

        if (stat.mtimeMs < cutoff) {
          const ageHours = Math.round((Date.now() - stat.mtimeMs) / (60 * 60 * 1000));
          fs.unlinkSync(fp);
          deleted++;
          log(`[Cleanup] deleted ${f} (${ageHours}h old)`);
        }
      } catch (err) {
        errors.push(`${f}: ${err.message}`);
      }
    }

    if (deleted > 0) {
      log(`[Cleanup] ✓ ${deleted} files deleted (> ${RETENTION_DAYS}d old)`);
    } else {
      log(`[Cleanup] ℹ no old files to delete (all within ${RETENTION_DAYS}d)`);
    }

    if (errors.length > 0) {
      log(`[Cleanup] ⚠ ${errors.length} file(s) failed to delete: ${errors.join("; ")}`);
    }
  } catch (err) {
    log(`[Cleanup] ✗ ERROR: ${err.message}`);
    // Not silent — ops needs to know cleanup broke so they can investigate disk bloat
    throw err;
  }
}

// ── Hard size cap (guardrail terakhir) ───────────────────────────────────────
// Bahkan jika cleanup by-mtime gagal (kode stale / retensi ke-override / mtime
// aneh), ini menjamin folder tidak pernah melewati MAX_DIR_GB: hapus dump
// TERTUA lebih dulu sampai < cap, selalu sisakan KEEP_MIN restore point.
// Inilah lapisan yang mencegah 72GB bloat berulang.

function enforceSizeCap() {
  const capBytes = MAX_DIR_GB * 1024 * 1024 * 1024;
  let entries;
  try {
    entries = fs.readdirSync(BACKUP_DIR)
      .filter((f) => !f.startsWith("latest") && !f.startsWith("trades_latest") && !f.startsWith("sessions_latest"))
      .map((f) => {
        const fp = path.join(BACKUP_DIR, f);
        const st = fs.lstatSync(fp);
        return st.isSymbolicLink() ? null : { f, fp, size: st.size, mtime: st.mtimeMs };
      })
      .filter(Boolean);
  } catch (err) {
    log(`[SizeCap] ✗ readdir ERROR: ${err.message}`);
    return;
  }

  let total = entries.reduce((s, e) => s + e.size, 0);
  const gb = (b) => (b / 1024 / 1024 / 1024).toFixed(2);
  if (total <= capBytes) {
    log(`[SizeCap] ℹ ${gb(total)}GB ≤ cap ${MAX_DIR_GB}GB — OK`);
    return;
  }

  // Prioritaskan hapus dump .sql.gz (biang volume) dari yang TERTUA.
  const dumps = entries.filter((e) => e.f.endsWith(".sql.gz")).sort((a, b) => a.mtime - b.mtime);
  const others = entries.filter((e) => !e.f.endsWith(".sql.gz")).sort((a, b) => a.mtime - b.mtime);
  const purgeOrder = [...dumps, ...others];

  let kept = 0, deleted = 0;
  log(`[SizeCap] ⚠ ${gb(total)}GB > cap ${MAX_DIR_GB}GB — memangkas dump tertua`);
  for (const e of purgeOrder) {
    if (total <= capBytes) break;
    // Selalu sisakan KEEP_MIN dump terbaru sebagai restore point.
    const remainingDumps = purgeOrder.filter((x) => x.f.endsWith(".sql.gz")).length - deleted;
    if (e.f.endsWith(".sql.gz") && remainingDumps <= KEEP_MIN) { kept++; continue; }
    try {
      fs.unlinkSync(e.fp);
      total -= e.size;
      deleted++;
      log(`[SizeCap] deleted ${e.f} (${gb(e.size)}GB)`);
    } catch (err) {
      log(`[SizeCap] ⚠ gagal hapus ${e.f}: ${err.message}`);
    }
  }
  log(`[SizeCap] ✓ ${deleted} file dihapus → ${gb(total)}GB (cap ${MAX_DIR_GB}GB, sisa ${KEEP_MIN} restore point dijaga)`);
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

    // 3. pg_dump (prod saja secara default — non-prod CSV-only untuk cegah bloat)
    if (!FULL_DUMP) {
      log(`  pg_dump       : skip (non-prod ${APP_ENV || "?"} — CSV-only, BACKUP_FULL_DUMP=true untuk paksa)`);
    } else {
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
    }

    log(`Backup selesai ✅`);
  } catch (err) {
    log(`ERROR: ${err.message}`);
  } finally {
    // ALWAYS cleanup, even if backup failed — prevents disk bloat from silently breaking cleanup.
    // This was root cause of 72GB bloat: cleanup() was skipped on error, files accumulated forever.
    try {
      cleanup();
    } catch (err) {
      log(`[Cleanup] FATAL: ${err.message}`);
    }
    // Guardrail terakhir: hard size-cap walau cleanup by-mtime gagal total.
    try {
      enforceSizeCap();
    } catch (err) {
      log(`[SizeCap] FATAL: ${err.message}`);
    }
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
  console.log(
    `[Backup] Terjadwal tiap ${intervalHours}j → ${BACKUP_DIR} ` +
    `(env=${APP_ENV || "prod"}, retain ${RETENTION_DAYS}h, fullDump=${FULL_DUMP}, cap ${MAX_DIR_GB}GB, keepMin ${KEEP_MIN})`,
  );
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/** Backup manual — bisa dipanggil dari endpoint admin */
async function backupNow() {
  await runBackup();
}

module.exports = { start, stop, backupNow };
