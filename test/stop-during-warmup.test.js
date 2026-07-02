/**
 * Regression: stop() during warm-up must NOT leave a zombie coordinator/engine.
 *
 * Bug (2026-06-19): tick-jitter made engine.start() slow (await 0–30s), so a
 * coordinator could be in `starting` (not yet `running`) for up to ~2 min while
 * spawning N engines. A Stop All issued in that window:
 *   - skipped the route's instance.stop() guard (only checked `running`), and
 *   - even when stop() ran, start()'s spawn loop kept creating engines AFTER stop
 *     cleared the map → orphan engines ticking forever while the DB said "stopped".
 *
 * These tests prove the coordinator now aborts an in-progress start() when stop()
 * lands mid-warm-up, and never marks itself running.
 *
 * Standalone runner: exit code != 0 if any assertion fails.
 */
const MultiStrategyCoordinator = require("../src/application/MultiStrategyCoordinator");
const AccountCoordinator = require("../src/domain/AccountCoordinator");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

// Fake engine whose start() blocks on an externally-resolvable gate, so we can
// freeze the coordinator mid-spawn and inject a stop() at a deterministic point.
function makeSlowEngine(strategyKey, cfg, gate) {
  return {
    strategyKey, cfg,
    started: false, stopped: false,
    state: { running: false, openPositions: [], trades: [], lastSignal: null, capital: cfg.capital },
    async start() {
      this.started = true;
      await gate.promise;          // block until the test releases the gate
      this.state.running = true;
    },
    async stop() { this.stopped = true; this.state.running = false; },
    getState() { return this.state; },
    getPendingSignal() { return null; },
    applyConflictDecision() {},
    on() {}, emit() {},
  };
}

function makeGate() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, release: () => resolve() };
}

console.log("\n🛑 Stop-during-warm-up regression\n");

(async () => {
  // ── Scenario: stop() called while coordinator is spawning engine #1 ──────────
  {
    const created = [];
    const gates = [];
    const factory = (key, cfg) => {
      const gate = makeGate();
      gates.push(gate);
      const e = makeSlowEngine(key, cfg, gate);
      created.push(e);
      return e;
    };
    const ac = new AccountCoordinator({ userId: "u1", maxAccountUtilization: 0.8 });
    ac.setAccountEquity(1000);

    const c = new MultiStrategyCoordinator({
      userId: "u1", symbol: "ETHUSDT",
      strategies: ["ADAPTIVE_FUSION", "TREND_FOLLOWING", "MEAN_REVERSION", "BREAKOUT_RETEST"],
      totalCapital: 1000, engineFactory: factory, accountCoordinator: ac,
    });

    // Begin start(): it will create engine #0 and block on its gate.
    const startP = c.start();
    await new Promise(r => setTimeout(r, 10)); // let the loop reach engine #0's await

    t("warm-up: only engine #0 spawned so far", created.length === 1);
    t("warm-up: coordinator not yet running", c.getState().running === false);
    t("warm-up: coordinator is starting", c.getState().starting === true);

    // STOP arrives mid-warm-up.
    const stopP = c.stop();

    // Release engine #0's gate so start()'s loop can proceed past the await.
    gates[0].release();

    await Promise.allSettled([startP, stopP]);
    // Drain any pending microtasks / cleanup awaits.
    await new Promise(r => setTimeout(r, 20));

    t("stop mid-warm-up → coordinator NOT running (no zombie)", c.getState().running === false);
    t("stop mid-warm-up → spawn loop aborted (did not create all 4 engines)",
      created.length < 4);
    t("stop mid-warm-up → every spawned engine was stopped",
      created.every(e => e.stopped));
    t("stop mid-warm-up → engines map cleared", c.engines.size === 0);
    t("stop mid-warm-up → group margin released", ac.committedMargin() === 0);
  }

  // ── Sanity: a normal start→stop still works end-to-end ───────────────────────
  {
    const created = [];
    const factory = (key, cfg) => {
      const gate = makeGate(); gate.release(); // resolve immediately = fast engine
      const e = makeSlowEngine(key, cfg, gate);
      created.push(e);
      return e;
    };
    const ac = new AccountCoordinator({ userId: "u2", maxAccountUtilization: 0.8 });
    ac.setAccountEquity(1000);
    const c = new MultiStrategyCoordinator({
      userId: "u2", symbol: "BTCUSDT",
      strategies: ["ADAPTIVE_FUSION", "TREND_FOLLOWING"],
      totalCapital: 1000, engineFactory: factory, accountCoordinator: ac,
    });
    await c.start();
    t("normal start → coordinator running", c.getState().running === true);
    t("normal start → all engines started", created.every(e => e.started));
    await c.stop();
    t("normal stop → coordinator not running", c.getState().running === false);
    t("normal stop → all engines stopped", created.every(e => e.stopped));
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} STOP-DURING-WARMUP: ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
