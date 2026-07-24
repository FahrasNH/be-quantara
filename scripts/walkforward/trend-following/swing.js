#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "TREND_FOLLOWING", tradeType: "Swing", slug: "trend-following" });
