#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "TREND_FOLLOWING", tradeType: "Intraday", slug: "trend-following" });
