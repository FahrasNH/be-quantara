#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "MEAN_REVERSION", tradeType: "Swing", slug: "mean-reversion" });
