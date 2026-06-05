const AuthService = require('../services/AuthService');

/**
 * JWT Authentication middleware
 * Verifies token and attaches user to request
 */
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'No token provided',
      statusCode: 401,
    });
  }

  const payload = AuthService.verifyAccessToken(token);

  if (!payload) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid or expired token',
      statusCode: 401,
    });
  }

  // Attach user ID to request
  req.userId = payload.userId;
  next();
}

/**
 * Optional auth - doesn't require token but extracts if present
 */
function optionalAuthMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];

  if (token) {
    const payload = AuthService.verifyAccessToken(token);
    if (payload) {
      req.userId = payload.userId;
    }
  }

  next();
}

module.exports = {
  authMiddleware,
  optionalAuthMiddleware,
};
