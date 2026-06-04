/**
 * Centralized error handling middleware
 * Catches all errors and returns consistent JSON responses
 */

const { AppError } = require("../errors/AppError");

/**
 * Express error handler middleware
 * Must be placed AFTER all other middleware and routes
 */
function errorHandler(err, req, res, next) {
  console.error("[ERROR]", err.message, err.stack?.split("\n")[1]);

  // Handle AppError (custom) vs generic Error
  const isAppError = err instanceof AppError;

  const response = {
    ok: false,
    statusCode: isAppError ? err.statusCode : 500,
    error: isAppError ? err.code : "INTERNAL_SERVER_ERROR",
    message: err.message || "An unexpected error occurred",
    timestamp: new Date().toISOString(),
    requestId: res.headersSent ? undefined : req.headers["x-request-id"],
  };

  // Add context if available
  if (isAppError && err.context && Object.keys(err.context).length > 0) {
    response.context = err.context;
  }

  // Don't expose stack traces in production
  if (process.env.NODE_ENV === "development") {
    response.stack = err.stack;
  }

  const statusCode = response.statusCode;
  res.status(statusCode).json(response);
}

/**
 * Request validation middleware
 * Validates request body and query parameters
 */
function validateRequest(schema) {
  return (req, res, next) => {
    // TODO: Use Joi or Zod for validation
    // For now, just pass through
    next();
  };
}

/**
 * Async handler wrapper for Express routes
 * Catches async errors and passes to error handler
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  errorHandler,
  validateRequest,
  asyncHandler,
};
