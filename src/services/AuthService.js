const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

class AuthService {
  /**
   * Register a new user
   */
  static async register(email, username, password) {
    // Validate input
    if (!email || !username || !password) {
      throw new Error('Email, username, and password required');
    }

    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    // Check if user exists
    const existing = await prisma.user.findFirst({
      where: {
        OR: [{ email }, { username }],
      },
    });

    if (existing) {
      throw new Error(existing.email === email ? 'Email already registered' : 'Username already taken');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        username,
        password: hashedPassword,
      },
    });

    // Create default strategy
    await prisma.userStrategy.create({
      data: {
        userId: user.id,
        strategyKey: 'ADAPTIVE_FUSION',
      },
    });

    return {
      id: user.id,
      email: user.email,
      username: user.username,
    };
  }

  /**
   * Login user
   */
  static async login(email, password) {
    if (!email || !password) {
      throw new Error('Email and password required');
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new Error('Invalid credentials');
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      throw new Error('Invalid credentials');
    }

    // Generate tokens
    const tokens = this.generateTokens(user.id);

    // Hash refresh token before storage
    const refreshTokenHash = await bcrypt.hash(tokens.refreshToken, 12);

    // Save refresh token hash
    await prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        balance: user.balance,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  /**
   * Verify JWT token
   */
  static verifyAccessToken(token) {
    try {
      return jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return null;
    }
  }

  /**
   * Refresh access token
   */
  static async refreshAccessToken(refreshToken) {
    try {
      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      const userId = decoded.userId;

      // Find session for this user
      const session = await prisma.session.findFirst({
        where: { userId },
      });

      if (!session) {
        throw new Error('Session not found');
      }

      if (session.expiresAt < new Date()) {
        throw new Error('Refresh token expired');
      }

      // Verify token against bcrypt hash — plaintext storage removed (P1.3 hardening).
      if (!session.refreshTokenHash) {
        throw new Error('Invalid refresh token');
      }

      const tokenValid = await bcrypt.compare(refreshToken, session.refreshTokenHash);
      if (!tokenValid) {
        throw new Error('Invalid refresh token');
      }

      // Generate new access token
      const newAccessToken = jwt.sign(
        { userId },
        process.env.JWT_SECRET,
        { expiresIn: '15m' }
      );

      return newAccessToken;
    } catch (err) {
      throw new Error('Invalid refresh token');
    }
  }

  /**
   * Generate JWT tokens
   */
  static generateTokens(userId) {
    const accessToken = jwt.sign(
      { userId },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    const refreshToken = jwt.sign(
      { userId },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: '7d' }
    );

    return { accessToken, refreshToken };
  }

  /**
   * Get user by ID
   */
  static async getUserById(userId) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        balance: true,
        createdAt: true,
      },
    });
  }

  /**
   * Logout user - delete refresh token
   */
  static async logout(userId) {
    // Delete all sessions for the user (logout all devices)
    await prisma.session.deleteMany({
      where: { userId },
    });
  }

  /**
   * Log user action
   */
  static async logAction(userId, action, resource, resourceId, ipAddress, userAgent) {
    return prisma.auditLog.create({
      data: {
        userId,
        action,
        resource,
        resourceId,
        ipAddress,
        userAgent,
      },
    });
  }
}

module.exports = AuthService;
