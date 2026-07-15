// ─── src/middleware/adminGuard.js ───────────────────────────────────────────
// Role-based guard for /admin/* dashboard endpoints (ADMIN-BE-02).
//
// Runs AFTER authMiddleware (which sets req.userId from a valid JWT). It loads
// the caller's role from the database — not the token — so a demotion takes
// effect immediately without waiting for the access token to expire. The role
// is cached on req.adminUser for downstream handlers.
// ─────────────────────────────────────────────────────────────────────────────
const prisma = require("../../infrastructure/db/prismaClient");

const ADMIN_ROLES = ["ADMIN", "SUPER_ADMIN"];

function makeGuard(allowedRoles) {
  return async function guard(req, res, next) {
    try {
      if (!req.userId) {
        return res.status(401).json({ ok: false, statusCode: 401, message: "Unauthorized" });
      }

      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { id: true, username: true, email: true, role: true },
      });

      if (!user) {
        return res.status(401).json({ ok: false, statusCode: 401, message: "Unauthorized" });
      }

      if (!allowedRoles.includes(user.role)) {
        return res.status(403).json({ ok: false, statusCode: 403, message: "Forbidden — admin access required" });
      }

      req.adminUser = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Any admin (ADMIN or SUPER_ADMIN) — used for the dashboard read endpoints.
const adminGuard = makeGuard(ADMIN_ROLES);

// SUPER_ADMIN only — for destructive admin-management actions (ADMIN-FE-04).
const superAdminGuard = makeGuard(["SUPER_ADMIN"]);

module.exports = { adminGuard, superAdminGuard, ADMIN_ROLES };
