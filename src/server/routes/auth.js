const AuthService = require('../../services/AuthService');
const { asyncHandler } = require('../../middleware/errorHandler');
const { authMiddleware } = require('../../middleware/auth');
const {
  validateLoginInput,
  validateRegisterInput,
} = require('../../middleware/validation');
const rateLimit = require('express-rate-limit');

module.exports = function createAuthRoutes() {
  const express = require('express');
  const router = express.Router();

  // Rate limiter for token refresh (20 req/15min per IP)
  const refreshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyGenerator: (req) => req.ip,
    handler: (req, res) => {
      res.status(429).json({
        ok: false,
        statusCode: 429,
        message: 'Too many refresh requests, please try again later',
        retryAfter: Math.ceil(req.rateLimit.resetTime / 1000),
      });
    },
  });

  /**
   * POST /api/v1/auth/register
   * Register new user
   */
  router.post(
    '/register',
    validateRegisterInput,
    asyncHandler(async (req, res) => {
      const { email, username, password } = req.body;

      try {
        const user = await AuthService.register(email, username, password);

        await AuthService.logAction(
          user.id,
          'REGISTER',
          'user',
          user.id,
          req.ip,
          req.headers['user-agent']
        );

        res.status(201).json({
          ok: true,
          message: 'User registered successfully',
          user,
        });
      } catch (err) {
        // Return validation errors with proper format
        res.status(400).json({
          ok: false,
          statusCode: 400,
          message: err.message,
          errors: [err.message],
        });
      }
    })
  );

  /**
   * POST /api/v1/auth/login
   * Login user
   */
  router.post(
    '/login',
    validateLoginInput,
    asyncHandler(async (req, res) => {
      const { email, password } = req.body;

      try {
        const result = await AuthService.login(email, password);

        await AuthService.logAction(
          result.user.id,
          'LOGIN',
          'user',
          result.user.id,
          req.ip,
          req.headers['user-agent']
        );

        res.json({
          ok: true,
          message: 'Logged in successfully',
          ...result,
        });
      } catch (err) {
        // Return auth errors with proper format
        res.status(401).json({
          ok: false,
          statusCode: 401,
          message: err.message,
          errors: [err.message],
        });
      }
    })
  );

  /**
   * POST /api/v1/auth/refresh
   * Refresh access token
   */
  router.post(
    '/refresh',
    refreshLimiter,
    asyncHandler(async (req, res) => {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: 'Refresh token required',
          errors: ['Refresh token is required'],
        });
      }

      try {
        const accessToken = await AuthService.refreshAccessToken(refreshToken);

        res.json({
          ok: true,
          accessToken,
        });
      } catch (err) {
        res.status(401).json({
          ok: false,
          statusCode: 401,
          message: err.message,
          errors: [err.message],
        });
      }
    })
  );

  /**
   * GET /api/v1/auth/me
   * Get current user info (requires auth)
   */
  router.get(
    '/me',
    authMiddleware,
    asyncHandler(async (req, res) => {
      if (!req.userId) {
        return res.status(401).json({
          ok: false,
          statusCode: 401,
          message: 'Unauthorized',
        });
      }

      const user = await AuthService.getUserById(req.userId);

      if (!user) {
        return res.status(404).json({
          ok: false,
          statusCode: 404,
          message: 'User not found',
        });
      }

      res.json({
        ok: true,
        user,
      });
    })
  );

  /**
   * POST /api/v1/auth/logout
   * Logout user - invalidate refresh token
   */
  router.post(
    '/logout',
    authMiddleware,
    asyncHandler(async (req, res) => {
      if (!req.userId) {
        return res.status(401).json({
          ok: false,
          statusCode: 401,
          message: 'Unauthorized',
        });
      }

      await AuthService.logout(req.userId);

      await AuthService.logAction(
        req.userId,
        'LOGOUT',
        'session',
        req.userId,
        req.ip,
        req.headers['user-agent']
      );

      res.json({
        ok: true,
        message: 'Logged out successfully',
      });
    })
  );

  return router;
};
