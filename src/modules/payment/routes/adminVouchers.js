// ─── src/server/routes/adminVouchers.js ─────────────────────────────────────
// Admin voucher CRUD (Sprint 5 / PAY-06). Mounted at /api/v1/admin/vouchers.
//
// JWT + admin-role protected (authMiddleware → adminGuard). Every mutation is
// written to the generic AuditLog (same pattern as routes/admin.js). Deletes are
// SOFT (deletedAt) so historical VoucherUsage rows keep their FK.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function createAdminVouchersRouter() {
  const express = require("express");
  const router = express.Router();
  const { asyncHandler } = require("../../../shared/middleware/errorHandler");
  const { authMiddleware } = require("../../../shared/middleware/auth");
  const { adminGuard } = require("../../../shared/middleware/adminGuard");
  const { VOUCHER_TYPES } = require("../domain/pricing");
  const { TIER_ORDER } = require("../../../core/risk-engine/tierConfig");
  const prisma = require("../../../infrastructure/db/prismaClient");

  const requireAdmin = [authMiddleware, adminGuard];

  async function audit(req, action, resourceId, details) {
    try {
      await prisma.auditLog.create({
        data: {
          userId: req.adminUser.id,
          action, resource: "VOUCHER", resourceId,
          details: details ? JSON.stringify(details) : null,
          ipAddress: req.ip || null,
          userAgent: req.headers["user-agent"] || null,
        },
      });
    } catch (_e) { /* best-effort */ }
  }

  const normCode = (c) => String(c || "").trim().toUpperCase();

  // Shape a voucher row for the admin UI — includes computed usage %.
  function present(v) {
    const usagePct = v.maxUses ? Math.round((v.currentUses / v.maxUses) * 100) : null;
    return {
      id: v.id,
      code: v.code,
      description: v.description,
      type: v.type,
      value: v.value,
      maxDiscount: v.maxDiscount,
      minPurchase: v.minPurchase,
      maxUses: v.maxUses,
      currentUses: v.currentUses,
      usagePct,
      maxUsesPerUser: v.maxUsesPerUser,
      applicableTiers: v.applicableTiers,
      validFrom: v.validFrom,
      validUntil: v.validUntil,
      isActive: v.isActive,
      deletedAt: v.deletedAt,
      createdAt: v.createdAt,
    };
  }

  // Validate a voucher create/update payload. Returns { error } or { data }.
  function validatePayload(body, { partial = false } = {}) {
    const data = {};
    const need = (k) => body[k] !== undefined && body[k] !== null;

    if (!partial || need("code")) {
      const code = normCode(body.code);
      if (!code || !/^[A-Z0-9_-]{3,32}$/.test(code)) {
        return { error: "code harus 3-32 karakter alfanumerik (A-Z 0-9 _ -)" };
      }
      data.code = code;
    }
    if (!partial || need("type")) {
      if (!VOUCHER_TYPES.includes(body.type)) return { error: `type harus salah satu dari: ${VOUCHER_TYPES.join(", ")}` };
      data.type = body.type;
    }
    if (!partial || need("value")) {
      const value = Number(body.value);
      if (!Number.isFinite(value) || value <= 0) return { error: "value harus angka > 0" };
      const type = data.type || body.type;
      if (type === "PERCENT" && value > 100) return { error: "value PERCENT tidak boleh > 100" };
      data.value = value;
    }
    if (need("maxDiscount")) {
      const md = Number(body.maxDiscount);
      if (!Number.isInteger(md) || md < 0) return { error: "maxDiscount harus integer >= 0" };
      data.maxDiscount = md;
    }
    if (need("minPurchase")) {
      const mp = Number(body.minPurchase);
      if (!Number.isInteger(mp) || mp < 0) return { error: "minPurchase harus integer >= 0" };
      data.minPurchase = mp;
    }
    if (need("maxUses")) {
      if (body.maxUses === "" ) { data.maxUses = null; }
      else {
        const mu = Number(body.maxUses);
        if (!Number.isInteger(mu) || mu < 1) return { error: "maxUses harus integer >= 1 (atau kosong = unlimited)" };
        data.maxUses = mu;
      }
    }
    if (need("maxUsesPerUser")) {
      const mpu = Number(body.maxUsesPerUser);
      if (!Number.isInteger(mpu) || mpu < 1) return { error: "maxUsesPerUser harus integer >= 1" };
      data.maxUsesPerUser = mpu;
    }
    if (need("applicableTiers")) {
      const tiers = Array.isArray(body.applicableTiers) ? body.applicableTiers : [];
      const bad = tiers.find((t) => !TIER_ORDER.includes(t));
      if (bad) return { error: `applicableTiers tidak valid: ${bad}` };
      data.applicableTiers = tiers;
    }
    if (need("validFrom")) {
      const d = new Date(body.validFrom);
      if (isNaN(d.getTime())) return { error: "validFrom bukan tanggal valid" };
      data.validFrom = d;
    }
    if (!partial || need("validUntil")) {
      const d = new Date(body.validUntil);
      if (isNaN(d.getTime())) return { error: "validUntil wajib & harus tanggal valid" };
      data.validUntil = d;
    }
    if (need("description")) data.description = String(body.description).slice(0, 280);
    if (need("isActive")) data.isActive = Boolean(body.isActive);

    return { data };
  }

  // POST /api/v1/admin/vouchers — create
  router.post(
    "/",
    ...requireAdmin,
    asyncHandler(async (req, res) => {
      const { error, data } = validatePayload(req.body || {}, { partial: false });
      if (error) return res.status(400).json({ ok: false, statusCode: 400, message: error });

      const existing = await prisma.voucher.findUnique({ where: { code: data.code } });
      if (existing) return res.status(409).json({ ok: false, statusCode: 409, message: `Voucher ${data.code} sudah ada` });

      const voucher = await prisma.voucher.create({ data: { ...data, createdBy: req.adminUser.id } });
      await audit(req, "VOUCHER_CREATE", voucher.id, { code: voucher.code, type: voucher.type, value: voucher.value });
      res.status(201).json({ ok: true, voucher: present(voucher) });
    })
  );

  // GET /api/v1/admin/vouchers?search=&sort=&order=&page=&pageSize=&includeDeleted=
  router.get(
    "/",
    ...requireAdmin,
    asyncHandler(async (req, res) => {
      const take = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 100);
      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const skip = (page - 1) * take;

      const where = {};
      if (req.query.includeDeleted !== "true") where.deletedAt = null;
      if (req.query.search) {
        const s = String(req.query.search).trim();
        where.OR = [
          { code: { contains: s.toUpperCase() } },
          { description: { contains: s, mode: "insensitive" } },
        ];
      }

      const SORTABLE = ["createdAt", "code", "currentUses", "validUntil", "value"];
      const sort = SORTABLE.includes(req.query.sort) ? req.query.sort : "createdAt";
      const order = req.query.order === "asc" ? "asc" : "desc";

      const [total, rows] = await Promise.all([
        prisma.voucher.count({ where }),
        prisma.voucher.findMany({ where, orderBy: { [sort]: order }, skip, take }),
      ]);

      res.json({ ok: true, items: rows.map(present), page, pageSize: take, total, totalPages: Math.ceil(total / take) });
    })
  );

  // GET /api/v1/admin/vouchers/:id — detail (+ recent usage count)
  router.get(
    "/:id",
    ...requireAdmin,
    asyncHandler(async (req, res) => {
      const voucher = await prisma.voucher.findUnique({ where: { id: req.params.id } });
      if (!voucher) return res.status(404).json({ ok: false, statusCode: 404, message: "Voucher tidak ditemukan" });
      res.json({ ok: true, voucher: present(voucher) });
    })
  );

  // PATCH /api/v1/admin/vouchers/:id — update
  router.patch(
    "/:id",
    ...requireAdmin,
    asyncHandler(async (req, res) => {
      const voucher = await prisma.voucher.findUnique({ where: { id: req.params.id } });
      if (!voucher) return res.status(404).json({ ok: false, statusCode: 404, message: "Voucher tidak ditemukan" });

      const { error, data } = validatePayload(req.body || {}, { partial: true });
      if (error) return res.status(400).json({ ok: false, statusCode: 400, message: error });

      // If code changed, enforce uniqueness.
      if (data.code && data.code !== voucher.code) {
        const dup = await prisma.voucher.findUnique({ where: { code: data.code } });
        if (dup) return res.status(409).json({ ok: false, statusCode: 409, message: `Voucher ${data.code} sudah ada` });
      }

      const updated = await prisma.voucher.update({ where: { id: voucher.id }, data });
      await audit(req, "VOUCHER_UPDATE", voucher.id, { changes: Object.keys(data) });
      res.json({ ok: true, voucher: present(updated) });
    })
  );

  // DELETE /api/v1/admin/vouchers/:id — soft delete (also deactivates)
  router.delete(
    "/:id",
    ...requireAdmin,
    asyncHandler(async (req, res) => {
      const voucher = await prisma.voucher.findUnique({ where: { id: req.params.id } });
      if (!voucher) return res.status(404).json({ ok: false, statusCode: 404, message: "Voucher tidak ditemukan" });
      if (voucher.deletedAt) return res.json({ ok: true, message: "Voucher sudah dihapus" });

      await prisma.voucher.update({ where: { id: voucher.id }, data: { deletedAt: new Date(), isActive: false } });
      await audit(req, "VOUCHER_DELETE", voucher.id, { code: voucher.code });
      res.json({ ok: true, message: `Voucher ${voucher.code} dihapus` });
    })
  );

  return router;
};
