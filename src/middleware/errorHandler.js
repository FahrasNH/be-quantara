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
    return res.status(err.statusCode).json({
      ok: false,
      statusCode: err.statusCode,
      message: err.message,
      errors: [err.message],
    });
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
