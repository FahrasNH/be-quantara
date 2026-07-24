#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "AUCTION_MARKET_THEORY", tradeType: "Intraday", slug: "auction-market-theory" });
