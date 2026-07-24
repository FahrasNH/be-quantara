#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "STATISTICAL_ARBITRAGE", tradeType: "Scalping", slug: "statistical-arbitrage" });
