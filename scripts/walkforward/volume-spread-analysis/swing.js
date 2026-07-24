#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "VOLUME_SPREAD_ANALYSIS", tradeType: "Swing", slug: "volume-spread-analysis" });
