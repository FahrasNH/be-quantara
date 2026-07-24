#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "SUPPLY_AND_DEMAND", tradeType: "Scalping", slug: "supply-and-demand" });
