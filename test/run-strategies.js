/**
 * run-strategies.js — Executes all strategy test suites under plain `node`.
 *
 * Sets the jest-lite API as globals so test files written in the
 * describe/test/expect style run without Jest/Mocha installed, then runs
 * the combined registry once and reports a single summary.
 *
 * Run: node test/run-strategies.js   (also wired into `npm test`)
 */

const { describe, test, it, beforeEach, expect, run } = require("./helpers/jest-lite");

// Expose as globals so test files can use bare describe/test/expect
global.describe = describe;
global.test = test;
global.it = it;
global.beforeEach = beforeEach;
global.expect = expect;

// Register all strategy test suites
require("./TrendMomentumStrategy.test.js");
require("./MeanReversionStrategy.test.js");
require("./BreakoutRetestStrategy.test.js");
require("./Simulator.test.js");

// Execute everything and set process exit code on failure
run("Strategy Test Suites");
