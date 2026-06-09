/**
 * Validation middleware using simple schema validation
 */

function validateLoginInput(req, res, next) {
  const { email, password } = req.body;

  const errors = [];

  if (!email || typeof email !== 'string' || !email.includes('@')) {
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

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    errors.push('Valid email required');
  }

  if (!username || typeof username !== 'string' || username.length < 3) {
    errors.push('Username must be at least 3 characters');
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

  if (!symbol || typeof symbol !== 'string' || !symbol.match(/^[A-Z]+USDT$/)) {
    return res.status(400).json({
      ok: false,
      statusCode: 400,
      message: 'Invalid symbol format',
      errors: ['Symbol must be in format: BTCUSDT, ETHUSDT, etc.'],
    });
  }

  next();
}

module.exports = {
  validateLoginInput,
  validateRegisterInput,
  validateBotStartInput,
  validateSymbolParam,
};
