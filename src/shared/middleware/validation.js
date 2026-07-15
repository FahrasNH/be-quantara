/**
 * Validation middleware using simple schema validation
 */

// RFC-5321-safe email: rejects quotes, semicolons, HTML special chars
const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
// Username: alphanumeric + _ . - only, 3-30 chars (no HTML/script injection)
const USERNAME_RE = /^[a-zA-Z0-9_.\-]{3,30}$/;

function validateLoginInput(req, res, next) {
  const { email, password } = req.body;

  const errors = [];

  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
    errors.push('Valid email required');
  }

  if (!password || typeof password !== 'string' || password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }

  if (errors.length > 0) {
    return res.status(400).json({
      ok: false,
      statusCode: 400,
      message: 'Validation failed',
      errors,
    });
  }

  next();
}

function validateRegisterInput(req, res, next) {
  const { email, username, password } = req.body;
  const errors = [];

  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
    errors.push('Valid email required');
  }

  if (!username || typeof username !== 'string' || !USERNAME_RE.test(username)) {
    errors.push('Username must be 3-30 characters (letters, numbers, _ . - only)');
  }

  if (!password || typeof password !== 'string' || password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }

  if (errors.length > 0) {
    return res.status(400).json({
      ok: false,
      statusCode: 400,
      message: 'Validation failed',
      errors,
    });
  }

  next();
}

/**
 * Validasi input start bot.
 *
 * TASK 3.1 (Multi-Strategy per Coin): `strategyKey` BUKAN field wajib. Pada flow
 * baru, strategi ditentukan otomatis dari tier user (getTierStrategies) sehingga FE
 * tidak mengirim `strategyKey` sama sekali. Bila dikirim (FE lama / legacy), tetap
 * divalidasi sebagai string opsional agar backward-compatible.
 */
function validateBotStartInput(req, res, next) {
  const { strategyKey, capital, dryRun } = req.body;
  const errors = [];

  // Opsional — hanya divalidasi tipenya bila ada (tidak pernah required).
  if (strategyKey !== undefined && typeof strategyKey !== 'string') {
    errors.push('strategyKey must be a string when provided');
  }

  if (capital !== undefined && (typeof capital !== 'number' || !Number.isFinite(capital) || capital <= 0)) {
    errors.push('capital must be a positive number');
  }

  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    errors.push('dryRun must be a boolean');
  }

  if (errors.length > 0) {
    return res.status(400).json({
      ok: false,
      statusCode: 400,
      message: 'Validation failed',
      errors,
    });
  }

  next();
}

function validateSymbolParam(req, res, next) {
  const { symbol } = req.params;

  // Allow A-Z dan 0-9 sebelum suffix USDT. Banyak pair perp punya prefix angka —
  // 1000PEPEUSDT, 1000BONKUSDT, 1000SHIBUSDT, 1000FLOKIUSDT, dst. Regex lama
  // (^[A-Z]+USDT$) menolak digit → "Invalid symbol format" padahal simbol valid
  // dari API exchange. Tetap wajib diakhiri USDT (platform USDT-only) dan dibatasi
  // panjangnya untuk mencegah input abusif di URL param.
  if (
    !symbol ||
    typeof symbol !== 'string' ||
    symbol.length > 24 ||
    !/^[A-Z0-9]{1,20}USDT$/.test(symbol)
  ) {
    return res.status(400).json({
      ok: false,
      statusCode: 400,
      message: 'Invalid symbol format',
      errors: ['Symbol must be in format: BTCUSDT, ETHUSDT, 1000PEPEUSDT, etc.'],
    });
  }

  next();
}

function validateForgotPasswordInput(req, res, next) {
  const { email } = req.body;
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return res.status(400).json({
      ok: false, statusCode: 400, message: 'Valid email required', errors: ['Valid email required'],
    });
  }
  next();
}

function validateResetPasswordInput(req, res, next) {
  const { newPassword } = req.body;
  const { token } = req.query;
  const errors = [];

  if (!token || typeof token !== 'string' || token.length < 32) {
    errors.push('Valid reset token required');
  }
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    errors.push('New password must be at least 8 characters');
  }

  if (errors.length > 0) {
    return res.status(400).json({ ok: false, statusCode: 400, message: 'Validation failed', errors });
  }
  next();
}

module.exports = {
  validateLoginInput,
  validateRegisterInput,
  validateBotStartInput,
  validateSymbolParam,
  validateForgotPasswordInput,
  validateResetPasswordInput,
};
