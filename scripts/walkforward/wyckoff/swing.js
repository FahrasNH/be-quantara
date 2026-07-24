#!/usr/bin/env node
"use strict";

const { stubMain } = require("../lib/stubExport");

stubMain({ strategyKey: "WYCKOFF", tradeType: "Swing", slug: "wyckoff" });
