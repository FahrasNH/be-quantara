#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "LIQUIDATION_SQUEEZE", tradeType: "Swing", slug: "liquidation-squeeze" });
