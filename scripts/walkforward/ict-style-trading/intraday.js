#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "ICT_STYLE_TRADING", tradeType: "Intraday", slug: "ict-style-trading" });
