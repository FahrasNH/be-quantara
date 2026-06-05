const AuthService = require('../../services/AuthService');
const { asyncHandler } = require('../../middleware/errorHandler');
const {
  validateLoginInput,
  validateRegisterInput,
} = require('../../middleware/validation');

module.exports = function createAuthRoutes() {
  const express = require('express');
  const router = express.Router();

  /**
   * POST /api/v1/auth/register
   * Register new user
   */
  router.post(
    '/register',
    validateRegisterInput,
    asyncHandler(async (req, res) => {
      const { email, username, password } = req.body;

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
    })
  );

  /**
   * POST /api/v1/auth/refresh
   * Refresh access token
   */
  router.post(
    '/refresh',
    asyncHandler(async (req, res) => {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: 'Refresh token required',
        });
      }

      const accessToken = await AuthService.refreshAccessToken(refreshToken);

      res.json({
        ok: true,
        accessToken,
      });
    })
  );

  /**
   * GET /api/v1/auth/me
   * Get current user info (requires auth)
   */
  router.get(
    '/me',
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

  return router;
};
