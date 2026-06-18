// ─────────────────────────────────────────────────────────────────────────────
// prismaClient.js — SATU PrismaClient bersama untuk seluruh proses.
//
// AKAR MASALAH yang diperbaiki: sebelumnya ada 13 `new PrismaClient()` terpisah
// (router, service, engine). Tiap PrismaClient membuka connection pool sendiri ke
// Postgres (default ~CPU×2+1 koneksi). Di VPS kecil, total koneksi membengkak
// mendekati `max_connections` Postgres (default 100) saat banyak bot start
// bersamaan → Postgres menolak koneksi baru → query menggantung → server "seakan
// mati" sampai burst reda (refresh seolah menyembuhkan).
//
// Dengan satu client bersama + connection_limit eksplisit, total koneksi terikat
// dan stabil berapa pun jumlah bot yang start serentak.
// ─────────────────────────────────────────────────────────────────────────────
const { PrismaClient } = require("@prisma/client");

// Bound pool satu client ini. Boleh override via PRISMA_CONNECTION_LIMIT.
// Default 20 → cukup untuk start banyak bot serentak, tetap jauh di bawah
// max_connections Postgres (100) walau ada pg.Pool (database.js) berdampingan.
const CONNECTION_LIMIT = parseInt(process.env.PRISMA_CONNECTION_LIMIT, 10) || 20;

function buildUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  // Sisipkan connection_limit & pool_timeout bila belum ada — agar pool client
  // tunggal ini terikat (tidak ikut default CPU×2+1 yang bisa berbeda antar host).
  try {
    const u = new URL(raw);
    if (!u.searchParams.has("connection_limit"))
      u.searchParams.set("connection_limit", String(CONNECTION_LIMIT));
    if (!u.searchParams.has("pool_timeout"))
      u.searchParams.set("pool_timeout", "20"); // detik tunggu koneksi sebelum error (bukan hang selamanya)
    return u.toString();
  } catch {
    return raw; // URL non-standar — pakai apa adanya
  }
}

// Reuse lintas hot-reload (nodemon/dev) agar tidak menumpuk client saat file
// di-reload. Di produksi cukup dibuat sekali.
const globalForPrisma = globalThis;

// Hanya override datasource bila kita punya URL (hindari url:undefined). Tanpa
// DATABASE_URL, biarkan Prisma membaca dari env/schema seperti biasa.
const _url = buildUrl();
const _opts = { log: ["warn", "error"] };
if (_url) _opts.datasources = { db: { url: _url } };

const prisma =
  globalForPrisma.__quantaraPrisma || new PrismaClient(_opts);

if (!globalForPrisma.__quantaraPrisma) {
  globalForPrisma.__quantaraPrisma = prisma;
}

module.exports = prisma;
module.exports.prisma = prisma;
