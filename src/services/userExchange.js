const { encrypt, decrypt, isEncrypted, fingerprint } = require("../infrastructure/security/crypto");

// PrismaClient bersama (satu instance untuk seluruh proses) — lihat prismaClient.js
const prisma = require("../infrastructure/db/prismaClient");

function assertUserExchangeModel() {
  if (!prisma.userExchange) {
    const err = new Error(
      "Prisma client belum di-generate ulang. Jalankan: npx prisma generate && restart server."
    );
    err.statusCode = 500;
    throw err;
  }
}

function safeDecrypt(value) {
  if (!value) return null;
  return isEncrypted(value) ? decrypt(value) : value;
}

function mask(val) {
  if (!val || val.length < 8) return val ? "****" : null;
  return `${val.substring(0, 4)}****${val.substring(val.length - 4)}`;
}

/** Salin kredensial legacy (kolom User) ke UserExchange bila belum ada. */
async function migrateLegacyIfNeeded(userId) {
  assertUserExchangeModel();
  const [legacy, existing] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { apiKey: true, apiSecret: true, apiPassphrase: true, exchangeType: true, apiKeyHash: true },
    }),
    prisma.userExchange.count({ where: { userId, deletedAt: null } }),
  ]);

  if (existing > 0 || !legacy?.apiKey || !legacy?.apiSecret || !legacy?.apiKeyHash) return;

  await prisma.userExchange.create({
    data: {
      userId,
      exchangeType: legacy.exchangeType || "bitget",
      apiKey: legacy.apiKey,
      apiSecret: legacy.apiSecret,
      apiPassphrase: legacy.apiPassphrase,
      apiKeyHash: legacy.apiKeyHash,
    },
  });
}

async function listExchangesMasked(userId) {
  await migrateLegacyIfNeeded(userId);
  // Hanya tampilkan exchange aktif. Record yang sudah di-switch (soft-deleted,
  // deletedAt != null) TIDAK boleh muncul lagi sebagai "Connected".
  const rows = await prisma.userExchange.findMany({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((row) => ({
    exchangeType: row.exchangeType.toLowerCase(),
    apiKey: mask(safeDecrypt(row.apiKey)),
    apiSecret: mask(safeDecrypt(row.apiSecret)),
    apiPassphrase: row.apiPassphrase ? "****" : null,
    configured: true,
  }));
}

async function getExchangeCredentials(userId, exchangeType = "bitget") {
  await migrateLegacyIfNeeded(userId);

  // findFirst + deletedAt:null — jangan pakai kredensial yang sudah di-revoke (soft-deleted).
  const row = await prisma.userExchange.findFirst({
    where: { userId, exchangeType, deletedAt: null },
  });

  if (row) {
    return {
      exchangeType: row.exchangeType,
      apiKey: safeDecrypt(row.apiKey),
      apiSecret: safeDecrypt(row.apiSecret),
      apiPassphrase: safeDecrypt(row.apiPassphrase),
    };
  }

  // Fallback legacy User columns
  const legacy = await prisma.user.findUnique({
    where: { id: userId },
    select: { apiKey: true, apiSecret: true, apiPassphrase: true, exchangeType: true },
  });

  if (!legacy?.apiKey || !legacy?.apiSecret) return null;

  return {
    exchangeType: legacy.exchangeType || "bitget",
    apiKey: safeDecrypt(legacy.apiKey),
    apiSecret: safeDecrypt(legacy.apiSecret),
    apiPassphrase: safeDecrypt(legacy.apiPassphrase),
  };
}

async function upsertExchange(userId, { apiKey, apiSecret, apiPassphrase, exchangeType = "bitget" }) {
  exchangeType = (exchangeType || "bitget").toLowerCase();

  const existing = await prisma.userExchange.findUnique({
    where: { userId_exchangeType: { userId, exchangeType } },
  });

  const resolvedApiKey = apiKey || (existing ? safeDecrypt(existing.apiKey) : null);
  const resolvedSecret = apiSecret || (existing ? safeDecrypt(existing.apiSecret) : null);
  const resolvedPass = apiPassphrase !== undefined && apiPassphrase !== ""
    ? apiPassphrase
    : (existing ? safeDecrypt(existing.apiPassphrase) : null);

  if (!existing && (!apiKey || !apiSecret)) {
    const err = new Error("apiKey and apiSecret are required");
    err.statusCode = 400;
    throw err;
  }

  if (!resolvedApiKey || !resolvedSecret) {
    const err = new Error("apiKey and apiSecret are required");
    err.statusCode = 400;
    throw err;
  }

  if ((exchangeType === "bitget" || exchangeType === "okx") && !resolvedPass) {
    const err = new Error(`Passphrase wajib diisi untuk ${exchangeType === "bitget" ? "Bitget" : "OKX"}.`);
    err.statusCode = 400;
    throw err;
  }

  const apiKeyHash = fingerprint(resolvedApiKey);
  const conflict = await prisma.userExchange.findUnique({
    where: { apiKeyHash },
    select: { userId: true, exchangeType: true },
  });

  if (conflict && (conflict.userId !== userId || conflict.exchangeType !== exchangeType)) {
    const err = new Error("API key exchange ini sudah terhubung ke akun lain. Satu exchange account hanya boleh dipakai satu user.");
    err.statusCode = 409;
    throw err;
  }

  const data = {
    apiKey: encrypt(resolvedApiKey),
    apiSecret: encrypt(resolvedSecret),
    apiPassphrase: resolvedPass ? encrypt(resolvedPass) : null,
    apiKeyHash,
  };

  // Re-activate soft-deleted rows (e.g. after exchange switch) on reconnect.
  await prisma.userExchange.upsert({
    where: { userId_exchangeType: { userId, exchangeType } },
    create: { userId, exchangeType, deletedAt: null, ...data },
    update: { ...data, deletedAt: null },
  });

  // Policy 1-user-1-exchange: hanya satu exchange aktif — soft-delete sisanya.
  await prisma.userExchange.updateMany({
    where: { userId, deletedAt: null, NOT: { exchangeType } },
    data: { deletedAt: new Date() },
  });

  // Sinkronkan kolom legacy User ke exchange yang BARU disimpan (bukan yang terlama).
  const active = await prisma.userExchange.findFirst({
    where: { userId, exchangeType, deletedAt: null },
  });

  if (active) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        apiKey: active.apiKey,
        apiSecret: active.apiSecret,
        apiPassphrase: active.apiPassphrase,
        apiKeyHash: active.apiKeyHash,
        exchangeType: active.exchangeType,
      },
    });
  }

  return { exchangeType, configured: true };
}

async function deleteExchange(userId, exchangeType) {
  await migrateLegacyIfNeeded(userId);

  const deleted = await prisma.userExchange.deleteMany({
    where: { userId, exchangeType },
  });

  if (deleted.count === 0) {
    const err = new Error("Exchange tidak ditemukan");
    err.statusCode = 404;
    throw err;
  }

  const remaining = await prisma.userExchange.findFirst({
    where: { userId, deletedAt: null },
    orderBy: { updatedAt: "desc" },
  });

  if (remaining) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        apiKey: remaining.apiKey,
        apiSecret: remaining.apiSecret,
        apiPassphrase: remaining.apiPassphrase,
        apiKeyHash: remaining.apiKeyHash,
        exchangeType: remaining.exchangeType,
      },
    });
  } else {
    await prisma.user.update({
      where: { id: userId },
      data: {
        apiKey: null,
        apiSecret: null,
        apiPassphrase: null,
        apiKeyHash: null,
        exchangeType: null,
      },
    });
  }
}

module.exports = {
  listExchangesMasked,
  getExchangeCredentials,
  upsertExchange,
  deleteExchange,
  mask,
};
