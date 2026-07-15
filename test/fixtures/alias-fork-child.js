/** Forked by path-aliases.test.js — must live inside the package for #imports. */
"use strict";
const logger = require("#shared/logger");
const env = require("#config/env.js");
if (typeof logger.info !== "function") process.exit(2);
if (typeof env.validate !== "function") process.exit(3);
if (typeof process.send === "function") process.send({ ok: true });
setTimeout(() => process.exit(0), 20);
