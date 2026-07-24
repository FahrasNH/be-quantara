#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "VOLUME_SPREAD_ANALYSIS", tradeType: "Scalping", slug: "volume-spread-analysis" });
