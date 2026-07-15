/**
 * app/bootstrap.js — formal bootstrap entry (Sprint 14 Phase 3).
 * PM2 / npm start still use repo-root index.js which loads dotenv + crash handlers,
 * then requires this module (or server/app directly). Kept as the composition root.
 */
module.exports = require("../server/app");
