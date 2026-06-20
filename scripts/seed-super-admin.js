#!/usr/bin/env node
/**
 * seed-super-admin.js — Create (or promote) the first SUPER_ADMIN. (ADMIN-BE-06)
 *
 * Idempotent:
 *   - If no user with the given email exists → create one as SUPER_ADMIN,
 *     email pre-verified, with a default UserStrategy row.
 *   - If the user already exists → promote to SUPER_ADMIN (role only). The
 *     password is left untouched unless you pass --reset-password.
 *
 * Config via env (or .env):
 *   SUPER_ADMIN_EMAIL      (default admin@quantara.software)
 *   SUPER_ADMIN_USERNAME   (default superadmin)
 *   SUPER_ADMIN_PASSWORD   (required when creating a new user)
 *
 * Usage:
 *   node scripts/seed-super-admin.js
 *   SUPER_ADMIN_EMAIL=me@x.com SUPER_ADMIN_PASSWORD='S3cret!' node scripts/seed-super-admin.js
 *   node scripts/seed-super-admin.js --reset-password   # also reset password to SUPER_ADMIN_PASSWORD
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const bcrypt = require("bcryptjs");
const prisma = require("../src/infrastructure/db/prismaClient");

const RESET_PASSWORD = process.argv.includes("--reset-password");

const EMAIL    = process.env.SUPER_ADMIN_EMAIL    || "admin@quantara.software";
const USERNAME = process.env.SUPER_ADMIN_USERNAME || "superadmin";
const PASSWORD = process.env.SUPER_ADMIN_PASSWORD || "";

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });

  if (existing) {
    const data = { role: "SUPER_ADMIN" };
    if (RESET_PASSWORD) {
      if (!PASSWORD) throw new Error("--reset-password requires SUPER_ADMIN_PASSWORD");
      data.password = await bcrypt.hash(PASSWORD, 12);
    }
    const updated = await prisma.user.update({
      where: { id: existing.id },
      data,
      select: { id: true, email: true, username: true, role: true },
    });
    console.log(`✓ Existing user promoted/ensured SUPER_ADMIN${RESET_PASSWORD ? " (password reset)" : ""}:`);
    console.log(`  ${updated.email} (@${updated.username}) → ${updated.role}`);
    return;
  }

  if (!PASSWORD) {
    throw new Error(
      "Creating a new super admin requires SUPER_ADMIN_PASSWORD.\n" +
      "  e.g. SUPER_ADMIN_PASSWORD='ChangeMe!23' node scripts/seed-super-admin.js"
    );
  }

  const hashed = await bcrypt.hash(PASSWORD, 12);
  const user = await prisma.user.create({
    data: {
      email:           EMAIL,
      username:        USERNAME,
      password:        hashed,
      role:            "SUPER_ADMIN",
      emailVerifiedAt: new Date(),
      strategies:      { create: { strategyKey: "ADAPTIVE_FUSION" } },
    },
    select: { id: true, email: true, username: true, role: true },
  });

  console.log("✓ Super admin created:");
  console.log(`  Email:    ${user.email}`);
  console.log(`  Username: ${user.username}`);
  console.log(`  Role:     ${user.role}`);
}

main()
  .catch(err => { console.error("✗ seed-super-admin failed:", err.message); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
