#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "MARKET_STRUCTURE", tradeType: "Swing", slug: "market-structure" });
