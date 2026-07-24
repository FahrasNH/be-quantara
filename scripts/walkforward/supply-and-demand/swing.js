#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "SUPPLY_AND_DEMAND", tradeType: "Swing", slug: "supply-and-demand" });
