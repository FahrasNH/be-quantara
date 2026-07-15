/**
 * shared/logger — structured logger (pino).
 *
 * Prefer this over console.* for anything that may run in production.
 * Child loggers: `const log = require('#shared/logger').child({ component: 'BotEngine' })`
 *
 * Level via LOG_LEVEL (default: info; silent in NODE_ENV=test unless LOG_LEVEL set).
 */

"use strict";

const pino = require("pino");

const level =
  process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === "test" ? "silent" : "info");

const logger = pino({
  level,
  base: {
    service: "quantara-be",
    env: process.env.NODE_ENV || "development",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

module.exports = logger;
