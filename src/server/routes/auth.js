const AuthService = require('../../services/AuthService');
const { sendPasswordReset } = require('../../services/EmailService');
const { asyncHandler } = require('../../middleware/errorHandler');
const { authMiddleware } = require('../../middleware/auth');
const {
  validateLoginInput,
  validateRegisterInput,
  validateForgotPasswordInput,
  validateResetPasswordInput,
} = require('../../middleware/validation');
const rateLimit = require('express-rate-limit');
const cfg = require('../../config/env.js');

module.exports = function createAuthRoutes() {
  const express = require('express');
  const router = express.Router();

  // Rate limiter for token refresh (20 req/15min per IP)
  const refreshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({
        ok: false,
        statusCode: 429,
        message: 'Too many refresh requests, please try again later',
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

  // Rate limiter for forgot-password (3 req/15min per IP — prevents email flooding)
  const forgotLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({
        ok: false,
        statusCode: 429,
        message: 'Too many requests. Please wait 15 minutes before trying again.',
      });
    },
  });

  /**
   * POST /api/v1/auth/forgot-password
   * Initiate password reset — enumeration-safe (always 200 regardless of email existence).
   */
  router.post(
    '/forgot-password',
    forgotLimiter,
    validateForgotPasswordInput,
    asyncHandler(async (req, res) => {
      const { email } = req.body;

      // Fire-and-forget: don't await — attacker cannot time the response
      // to infer whether the email exists in the DB.
      AuthService.forgotPassword(email)
        .then(async (result) => {
          if (!result) return; // email not found — stay silent
          const resetUrl = `${cfg.APP_URL}/reset-password?token=${result.token}`;
          try {
            await sendPasswordReset(result.user.email, resetUrl);
          } catch (emailErr) {
            // Log but don't crash — email misconfiguration shouldn't break the response
            console.error('[forgot-password] email send failed:', emailErr.message);
          }
        })
        .catch((err) => {
          console.error('[forgot-password] unexpected error:', err.message);
        });

      // Always respond 200 immediately — enumeration-safe
      res.json({
        ok: true,
        message: 'If that email is registered, a reset link has been sent.',
      });
    })
  );

  /**
   * POST /api/v1/auth/reset-password?token=<rawToken>
   * Consume reset token and set new password. Invalidates all sessions.
   */
  router.post(
    '/reset-password',
    validateResetPasswordInput,
    asyncHandler(async (req, res) => {
      const { token } = req.query;
      const { newPassword } = req.body;

      try {
        await AuthService.resetPassword(token, newPassword);

        res.json({
          ok: true,
          message: 'Password updated successfully. Please log in with your new password.',
        });
      } catch (err) {
        res.status(400).json({
          ok: false,
          statusCode: 400,
          message: err.message,
          errors: [err.message],
        });
      }
    })
  );

  return router;
};
