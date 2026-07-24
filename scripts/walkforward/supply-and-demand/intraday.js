#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "SUPPLY_AND_DEMAND", tradeType: "Intraday", slug: "supply-and-demand" });
