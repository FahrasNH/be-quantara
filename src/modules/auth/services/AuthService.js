const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
// PrismaClient bersama (satu instance untuk seluruh proses) — lihat prismaClient.js
const prisma = require('../../../infrastructure/db/prismaClient');

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

    // Generate email verification token
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');

    // Create user (not yet verified)
    const user = await prisma.user.create({
      data: {
        email,
        username,
        password: hashedPassword,
        emailVerificationToken,
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
      emailVerificationToken,
    };
  }

  /**
   * Verify email using token from link.
   * Clears the token after successful verification (one-time use).
   */
  static async verifyEmail(token) {
    if (!token) throw new Error('Token verifikasi diperlukan.');

    const user = await prisma.user.findFirst({
      where: { emailVerificationToken: token },
    });

    if (!user) {
      const err = new Error('Link verifikasi tidak valid atau sudah kedaluwarsa.');
      err.statusCode = 400;
      err.code = 'INVALID_VERIFICATION_TOKEN';
      throw err;
    }

    if (user.emailVerifiedAt) {
      return { alreadyVerified: true };
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifiedAt: new Date(),
        emailVerificationToken: null,
      },
    });

    return { success: true, userId: user.id };
  }

  /**
   * Generate a new email verification token (for resend).
   */
  static async regenerateVerificationToken(email) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return null; // don't reveal existence
    if (user.emailVerifiedAt) {
      const err = new Error('Email sudah terverifikasi.');
      err.statusCode = 400;
      err.code = 'ALREADY_VERIFIED';
      throw err;
    }
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerificationToken: token },
    });
    return { email: user.email, token };
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

    // Suspended accounts cannot log in (ADMIN-BE-03 — admin suspend action).
    if (user.suspendedAt) {
      const err = new Error('Akun Anda telah ditangguhkan. Hubungi administrator.');
      err.statusCode = 403;
      err.code = 'ACCOUNT_SUSPENDED';
      throw err;
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
        role: user.role,
        balance: user.balance,
        emailVerified: !!user.emailVerifiedAt,
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

      // Multi-device (#12): satu user bisa punya banyak sesi (banyak device).
      // `findFirst` lama hanya mengambil SATU sesi → device lain gagal refresh
      // karena hash-nya tidak cocok. Cocokkan token ke SEMUA sesi user yang
      // masih berlaku via bcrypt.compare (hash tak bisa dicari lewat query).
      const sessions = await prisma.session.findMany({
        where: { userId, expiresAt: { gt: new Date() } },
      });

      if (!sessions || sessions.length === 0) {
        throw new Error('Session not found');
      }

      let matched = null;
      for (const s of sessions) {
        if (!s.refreshTokenHash) continue;
        // eslint-disable-next-line no-await-in-loop
        if (await bcrypt.compare(refreshToken, s.refreshTokenHash)) {
          matched = s;
          break;
        }
      }
      if (!matched) {
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
        role: true,
        balance: true,
        emailVerifiedAt: true,
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
   * Initiate password reset — generates token, stores hash, returns { token, user }.
   * Caller is responsible for sending the email (keeps service testable without SMTP).
   * Returns null when email not found — caller must NOT reveal this to the client
   * (enumeration-safe: always respond 200 regardless).
   */
  static async forgotPassword(email) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return null;

    // Invalidate all previous unused reset tokens for this user
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data:  { usedAt: new Date() },
    });

    // 32-byte cryptographically random token (hex string, 64 chars)
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = await bcrypt.hash(rawToken, 10);

    await prisma.passwordResetToken.create({
      data: {
        userId:    user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min TTL
      },
    });

    return { token: rawToken, user };
  }

  /**
   * Consume a reset token and update the password.
   * Deletes ALL sessions so the user is forced to log in again on every device.
   */
  static async resetPassword(rawToken, newPassword) {
    if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 32) {
      throw new Error('Invalid or missing reset token');
    }
    if (!newPassword || newPassword.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    // Find all non-expired, non-used tokens and test each one
    const candidates = await prisma.passwordResetToken.findMany({
      where: { usedAt: null, expiresAt: { gt: new Date() } },
    });

    let matched = null;
    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(rawToken, candidate.tokenHash)) {
        matched = candidate;
        break;
      }
    }

    if (!matched) {
      throw new Error('Reset token is invalid or has expired');
    }

    const newHash = await bcrypt.hash(newPassword, 12);

    // Atomic: update password + mark token used + delete all sessions
    await prisma.$transaction([
      prisma.user.update({
        where: { id: matched.userId },
        data:  { password: newHash },
      }),
      prisma.passwordResetToken.update({
        where: { id: matched.id },
        data:  { usedAt: new Date() },
      }),
      prisma.session.deleteMany({ where: { userId: matched.userId } }),
    ]);

    await this.logAction(matched.userId, 'PASSWORD_RESET', 'user', matched.userId, null, null);
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
