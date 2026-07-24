#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "BREAKOUT_RETEST", tradeType: "Scalping", slug: "breakout-retest" });
