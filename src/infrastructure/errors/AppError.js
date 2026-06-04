/**
 * Custom error class untuk Quantara
 * Memastikan consistent error responses di seluruh app
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = "UNKNOWN_ERROR", context = {}) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.context = context;
    this.timestamp = new Date().toISOString();

    // Capture stack trace
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      ok: false,
      statusCode: this.statusCode,
      error: this.code,
      message: this.message,
      context: this.context,
      timestamp: this.timestamp,
    };
  }
}

// Specific error classes
class ValidationError extends AppError {
  constructor(message, errors = []) {
    super(message, 400, "VALIDATION_ERROR", { errors });
  }
}

class NotFoundError extends AppError {
  constructor(message, resource = null) {
    super(message, 404, "NOT_FOUND", { resource });
  }
}

class ConflictError extends AppError {
  constructor(message, details = {}) {
    super(message, 409, "CONFLICT", details);
  }
}

class ExchangeError extends AppError {
  constructor(message, exchangeName = null) {
    super(message, 503, "EXCHANGE_ERROR", { exchange: exchangeName });
  }
}

class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED");
  }
}

class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, 403, "FORBIDDEN");
  }
}

class RateLimitError extends AppError {
  constructor(message = "Rate limit exceeded", retryAfter = 60) {
    super(message, 429, "RATE_LIMIT", { retryAfter });
  }
}

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  ExchangeError,
  UnauthorizedError,
  ForbiddenError,
  RateLimitError,
};
