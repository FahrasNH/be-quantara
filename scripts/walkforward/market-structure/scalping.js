#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "MARKET_STRUCTURE", tradeType: "Scalping", slug: "market-structure" });
