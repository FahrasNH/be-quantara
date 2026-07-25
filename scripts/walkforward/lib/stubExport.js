"use strict";

/**
 * Per-strategy entry scripts call stubMain({ strategyKey, tradeType, slug }).
 * Implementation lives in runWalkforwardMain.js (generic grid export).
 */
const { stubMain, walkforwardMain } = require("./runWalkforwardMain");

module.exports = { stubMain, walkforwardMain };
