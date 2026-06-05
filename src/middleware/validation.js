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

function validateBotStartInput(req, res, next) {
  const { strategyKey, capital } = req.body;
  const errors = [];

  if (strategyKey && typeof strategyKey !== 'string') {
    errors.push('strategyKey must be a string');
  }

  if (capital && (typeof capital !== 'number' || capital <= 0)) {
    errors.push('capital must be a positive number');
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
