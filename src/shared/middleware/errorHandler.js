/**
 * Global error handling middleware
 */

function errorHandler(err, req, res, next) {
  console.error('[ERROR]', err.message, err.stack);

  // Prisma errors
  if (err.code === 'P2002') {
    return res.status(409).json({
      ok: false,
      statusCode: 409,
      message: 'Resource already exists',
      errors: ['Unique constraint violation'],
    });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({
      ok: false,
      statusCode: 404,
      message: 'Resource not found',
      errors: [err.message],
    });
  }

  // Custom errors
  if (err.statusCode) {
    const body = {
      ok: false,
      statusCode: err.statusCode,
      message: err.message,
      errors: [err.message],
    };
    // Pass through optional structured fields when a handler attaches them
    // (e.g. Exchange Switch 409 guard exposes blockerReason + open positions —
    //  see API contract AC-01/AC-02). Only included when present.
    if (err.code !== undefined) body.code = err.code;
    if (err.blockerReason !== undefined) body.blockerReason = err.blockerReason;
    if (err.positions !== undefined) body.positions = err.positions;
    return res.status(err.statusCode).json(body);
  }

  // Generic error
  res.status(500).json({
    ok: false,
    statusCode: 500,
    message: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
    errors: process.env.NODE_ENV === 'production'
      ? []
      : [err.message],
  });
}

/**
 * Wrap async route handlers to catch errors
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  errorHandler,
  asyncHandler,
};
