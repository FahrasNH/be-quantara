// ─── src/infrastructure/security/crypto.js ───────────────────────────────────
// Enkripsi simetris AES-256-GCM untuk data sensitif (API keys exchange).
// Master key dibaca dari ENCRYPTION_KEY (hex 64 char = 32 byte) di .env —
// JANGAN simpan key ini di database. GCM memberi authentication tag sehingga
// data yang diutak-atik akan ditolak saat decrypt.
//
// Format hasil encrypt: "iv:authTag:ciphertext" (semua hex).
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV — rekomendasi untuk GCM
const KEY_LENGTH = 32; // 256-bit

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY tidak diset. Generate dengan: openssl rand -hex 32"
    );
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY harus 32 byte (64 hex char), dapat ${key.length} byte.`
    );
  }
  return key;
}

/**
 * Enkripsi plaintext → "iv:authTag:ciphertext" (hex).
 * @param {string} plaintext
 * @returns {string}
 */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === "") return null;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Dekripsi "iv:authTag:ciphertext" → plaintext.
 * Mengembalikan null kalau input kosong. Throw kalau format/auth tag invalid.
 * @param {string} payload
 * @returns {string|null}
 */
function decrypt(payload) {
  if (payload == null || payload === "") return null;

  const parts = String(payload).split(":");
  if (parts.length !== 3) {
    throw new Error("Format ciphertext tidak valid (harus iv:authTag:data).");
  }

  const [ivHex, authTagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(dataHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/**
 * Apakah string sudah dalam format terenkripsi (iv:authTag:ciphertext hex).
 * Berguna untuk membedakan data lama (plaintext) vs terenkripsi.
 * @param {string} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  if (!value || typeof value !== "string") return false;
  const parts = value.split(":");
  return parts.length === 3 && parts.every(p => /^[0-9a-f]+$/i.test(p));
}

/**
 * Fingerprint deterministik dari sebuah secret (mis. apiKey exchange).
 *
 * encrypt() menghasilkan ciphertext berbeda tiap panggilan (IV random), jadi
 * tidak bisa dipakai untuk unique constraint. fingerprint() memakai HMAC-SHA256
 * dengan master key sehingga input sama → output sama → bisa di-index unik untuk
 * mendeteksi apakah exchange API key yang sama sudah dipakai user lain.
 *
 * Memakai HMAC (bukan SHA polos) agar tidak rentan rainbow-table jika DB bocor.
 *
 * @param {string} plaintext
 * @returns {string|null} hex digest, atau null kalau input kosong
 */
function fingerprint(plaintext) {
  if (plaintext == null || plaintext === "") return null;
  return crypto
    .createHmac("sha256", getKey())
    .update(String(plaintext))
    .digest("hex");
}

module.exports = { encrypt, decrypt, isEncrypted, fingerprint };
