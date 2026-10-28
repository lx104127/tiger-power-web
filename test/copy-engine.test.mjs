import test from "node:test";
import assert from "node:assert/strict";
import { createCopyEngine } from "../panel/copy-engine.mjs";

const target = "0x" + "1".repeat(40), token = "0x" + "2".repeat(40);
function fixture(extra = {}) {
  let time = Date.UTC(2026, 9, 28, 10), saved, diskFails = false;
  const orders = [];
  const engine = createCopyEngine({ now: () => time,
    persist: value => { if (diskFails) throw new Error("test disk unavailable"); saved = structuredClone(value); },
    order: async plan => {
      orders.push(plan);
      assert.ok(saved.tasks[0].tokens[plan.ca], "reservation must exist before order dispatch");
      return { results: Object.fromEntries(plan.accts.map(a => [a, { ok: true, submitted: true }])) };
    }, ...extra,
  });
  const event = (id, patch = {}) => ({ id, type: "track", target, ca: token, platform: "gangv3", side: "buy", action: "建仓", quote: "BNB", quoteAmt: .02, ts: Math.floor(time / 1000), ...patch });
  const create = params => engine.task({ target, params: { maxCopies: 0, onlyFirst: false, ...params } });
  const live = params => {
    const t = create(params);
    engine.task({ id: t.id, params: { dryRun: false }, status: "running", confirmLive: true });
    return t;
  };
  return { engine, event, create, live, orders, saved: () => saved, failDisk: () => { diskFails = true; }, advance: ms => { time += ms; } };
}

test("follow tasks always start paused and simulated; real activation and resume require confirmation", () => {
  const f = fixture();
  const t = f.create({ dryRun: false, wallets: ["1", "2"] });
  assert.equal(t.status, "paused"); assert.equal(t.params.dryRun, true);
  assert.notEqual(t.id, f.create().id);
  assert.throws(() => f.engine.task({ id: t.id, params: { dryRun: false }, status: "running" }), /明确确认/);
  f.engine.task({ id: t.id, params: { dryRun: false }, status: "running", confirmLive: true });
  assert.throws(() => f.engine.task({ id: t.id, params: { dailyCap: 1 } }), /明确确认/);
  f.engine.pauseAll(true);
  assert.throws(() => f.engine.pauseAll(false), /确认/);
  f.engine.pauseAll(false, true);
});

test("paper mode applies two-wallet daily caps without dispatching orders, replay or backfill", async () => {
  const f = fixture();
  const t = f.create({ amountBnb: .02, dailyCap: .06, maxPerToken: .2, wallets: ["1", "2"] });
  f.engine.task({ id: t.id, status: "running" });
  await f.engine.processEvent(f.event("first"));
  await f.engine.processEvent(f.event("first"));
  await f.engine.processEvent(f.event("backfill", { backfill: true }));
  await f.engine.processEvent(f.event("second"));
  await f.engine.processEvent(f.event("third"));
  const state = f.engine.state().tasks[0];
  assert.equal(f.orders.length, 0);
  assert.equal(state.stats.simCopies, 2);
  assert.equal(state.stats.copies, 0);
  assert.ok(Math.abs(Object.values(state.paper.days)[0] - .06) < 1e-10);
  assert.deepEqual(state.days, {});
});

test("simultaneous events reserve the combined two-wallet budget before each actual attempt", async () => {
  const f = fixture();
  f.live({ amountBnb: .01, dailyCap: .03, maxPerToken: .1, wallets: ["1", "2"] });
  await Promise.all([f.engine.processEvent(f.event("one")), f.engine.processEvent(f.event("two")), f.engine.processEvent(f.event("three"))]);
  assert.deepEqual(f.orders.map(p => p.bnb), [.01, .005]);
  assert.ok(Math.abs(f.engine.state().tasks[0].stats.buyBnb - .03) < 1e-10);
});

test("a fixed or ratio amount cannot exceed the hard per-wallet cap", async () => {
  const f = fixture();
  f.live({ amountBnb: 100, maxPerTrade: 10, maxPerToken: 2, dailyCap: 2 });
  await f.engine.processEvent(f.event("capped"));
  assert.equal(f.orders[0].bnb, .5);
});

test("follow-sell only touches wallets that actually followed the buy, and rejects an unknown sell fraction", async () => {
  const f = fixture();
  const t = f.live({ wallets: ["1"], followSell: true });
  await f.engine.processEvent(f.event("buy"));
  f.engine.task({ id: t.id, params: { wallets: ["1", "2"] }, confirmLive: true });
  await f.engine.processEvent(f.event("unknown-sell", { side: "sell", action: "减仓" }));
  assert.equal(f.orders.length, 1);
  await f.engine.processEvent(f.event("sell", { side: "sell", action: "清仓" }));
  assert.equal(f.orders.length, 2);
  assert.deepEqual(f.orders[1].accts, ["1"]);
  assert.equal(f.orders[1].arg, "100");
});

test("an uncertain outcome retains the reservation and pauses instead of retrying after restart", async () => {
  const f = fixture({ order: async () => { throw new Error("test response lost after submission"); } });
  const t = f.live();
  await f.engine.processEvent(f.event("pending"));
  const state = f.engine.state();
  assert.equal(state.tasks[0].status, "paused");
  assert.equal(state.tasks[0].tokens[token].wallets["1"].pending, true);
  assert.equal(state.tasks[0].stats.buyBnb, .01);
  assert.throws(() => f.engine.task({ id: t.id, status: "running", confirmLive: true }), /核对/);
  const restarted = createCopyEngine({ initialState: f.saved(), order: async () => assert.fail("must not retry") });
  await restarted.processEvent(f.event("pending"));
  assert.equal(restarted.state().tasks[0].status, "paused");
});

test("persistence failure prevents execution and pauses the task", async () => {
  const f = fixture(); f.live(); f.failDisk();
  await f.engine.processEvent(f.event("disk-failure"));
  assert.equal(f.orders.length, 0);
  assert.equal(f.engine.state().tasks[0].stats.buyBnb, 0);
  assert.equal(f.engine.state().tasks[0].status, "paused");
});

test("a proven pre-dispatch rejection releases reservations without repeating the event", async () => {
  let attempts = 0;
  const f = fixture({ order: async () => { attempts++; const error = new Error("venue changed before dispatch"); error.code = "ORDER_NOT_STARTED"; throw error; } });
  f.live();
  await f.engine.processEvent(f.event("graduated"));
  await f.engine.processEvent(f.event("graduated"));
  assert.equal(attempts, 1);
  assert.equal(f.engine.state().tasks[0].stats.buyBnb, 0);
  assert.equal(f.engine.state().tasks[0].stats.copies, 0);
  assert.equal(f.engine.state().tasks[0].tokens[token].wallets["1"].pending, false);
});

test("pause or staleness during a quote prevents dispatch, and unknown market cap fails closed", async () => {
  let resolve;
  const f = fixture({ price: () => new Promise(done => { resolve = done; }) });
  f.live();
  const pending = f.engine.processEvent(f.event("waiting", { quote: "OTHER", usd: 10 }));
  await new Promise(done => setImmediate(done));
  f.engine.pauseAll(true); resolve(600); await pending;
  assert.equal(f.orders.length, 0);
  const g = fixture({ detect: async () => null }); g.live({ maxMcUsd: 1e6 });
  await g.engine.processEvent(g.event("unknown-cap"));
  await g.engine.processEvent(g.event("stale", { ts: g.event("now").ts - 60 }));
  assert.equal(g.orders.length, 0);
});

test("confirmed events are deduplicated after restart and simulated positions never become real holdings", async () => {
  const f = fixture();
  const t = f.create({ followSell: true }); f.engine.task({ id: t.id, status: "running" });
  await f.engine.processEvent(f.event("paper"));
  f.engine.task({ id: t.id, params: { dryRun: false }, confirmLive: true });
  await f.engine.processEvent(f.event("sell-paper", { side: "sell", action: "清仓" }));
  assert.equal(f.orders.length, 0);
  await f.engine.processEvent(f.event("real"));
  const restarted = createCopyEngine({ initialState: f.saved(), order: async () => assert.fail("duplicate event") });
  await restarted.processEvent(f.event("real"));
  assert.equal(restarted.state().tasks[0].stats.copies, 1);
});

test("reaching the buy-count limit still follows sells until the copied positions are closed", async () => {
  const f = fixture(); f.live({ maxCopies: 1, followSell: true });
  await f.engine.processEvent(f.event("buy-once"));
  assert.equal(f.engine.state().tasks[0].status, "running");
  assert.equal(f.engine.state().tasks[0].buyLimitReached, true);
  await f.engine.processEvent(f.event("no-second-buy"));
  assert.equal(f.orders.length, 1);
  await f.engine.processEvent(f.event("sell-half", { side: "sell", action: "减仓", pct: 50 }));
  assert.equal(f.engine.state().tasks[0].status, "running");
  await f.engine.processEvent(f.event("sell-all", { side: "sell", action: "清仓" }));
  assert.equal(f.engine.state().tasks[0].status, "closed");
  assert.equal(f.orders.length, 3);
});
