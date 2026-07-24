#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "MARKET_STRUCTURE", tradeType: "Intraday", slug: "market-structure" });
