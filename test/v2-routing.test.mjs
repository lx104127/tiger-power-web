import test from "node:test";
import assert from "node:assert/strict";
import { route, enforceBnbLimit } from "../panel/order-route.mjs";
import { assertSafePreview } from "../trade-safety.mjs";
import { assertNftEligibility } from "../flap-gate.mjs";
const ca = "0x" + "3".repeat(40);

test("Gang v3 and NFT-gated pools route each account to their own inner-pool script and graduate to DEX", () => {
  const g3 = { ca, platform: "gangv3", stage: "inner" };
  const half = route(g3, "buy", "2", "half");
  assert.ok(half.script.endsWith("gang/gangv3.mjs"));
  assert.deepEqual(half.args, ["buy", ca, "--tokens", "5000000", "--acct", "2"]);
  assert.deepEqual(route(g3, "sell", "1", "50", true).args, ["sell", ca, "50", "--acct", "1", "--app-confirm"]);
  const nft = { ca, platform: "flapportal", stage: "inner", cost1pctBnb: .01 };
  assert.deepEqual(route(nft, "buy", "2", ".02").args, ["buy", ca, ".02", "--acct", "2"]);
  assert.ok(route(nft, "sell", "1", "100").script.endsWith("flapportal.mjs"));
  for (const token of [g3, nft]) {
    assert.ok(route({ ...token, stage: "outer" }, "buy", "1", ".01").script.endsWith("dexbuy.mjs"));
    assert.ok(route({ ...token, stage: "outer" }, "sell", "2", "100").script.endsWith("dexsell.mjs"));
  }
});

test("unknown quantities and unsupported wallet slots fail before any script can be launched", () => {
  const token = { ca, platform: "gangv3", stage: "inner" };
  for (const value of ["p0", "p2", "p0.5junk", "-1", "NaN"]) assert.throws(() => route(token, "buy", "1", value));
  assert.throws(() => route(token, "buy", "both", "1pct"));
  assert.throws(() => route(token, "sell", "1", "101"));
});

test("BNB limits cover quote buffers and are enforced inside every Gang buy script", () => {
  for (const platform of ["four", "flapportal"]) {
    const d = { ca, platform, stage: "inner", cost1pct: .01, cost1pctBnb: .01 };
    const plans = [route(d, "buy", "1", "1pct")];
    assert.throws(() => enforceBnbLimit(d, "buy", plans, .01), /上限/);
  }
  for (const platform of ["gangv1", "gangv2", "gangv3"]) {
    const d = { ca, platform, stage: "inner" };
    const plans = [route(d, "buy", "2", "half")];
    enforceBnbLimit(d, "buy", plans, .05);
    assert.deepEqual(plans[0].args.slice(-2), ["--max-bnb", "0.05"]);
  }
});

test("failed simulations and high-risk address findings cannot be bypassed by App confirmation", () => {
  const safe = { success: true, data: { simulationResult: { simulationCode: "000000000" }, risks: { riskDetails: [] } } };
  assert.deepEqual(assertSafePreview(safe), []);
  assert.throws(() => assertSafePreview({ ...safe, data: { ...safe.data, simulationResult: { simulationCode: "FAILED" } } }), /模拟失败/);
  const medium = { ...safe, data: { ...safe.data, requireConfirmation: true, risks: { riskDetails: [{ code: "medium_contract" }] } } };
  assert.throws(() => assertSafePreview(medium));
  assert.equal(assertSafePreview(medium, { allowApp: true }).length, 1);
  const high = { ...medium, data: { ...medium.data, risks: { addresses: { [ca]: { riskDetails: [{ code: "high_contract" }] } } } } };
  assert.throws(() => assertSafePreview(high, { allowApp: true }), /风险/);
});

test("NFT gates check each wallet independently and stop on a missing NFT or unreadable gate", async () => {
  const first = "0x" + "1".repeat(40), second = "0x" + "2".repeat(40), seen = [];
  const reads = { readGate: async () => ca, readBalance: async (nft, wallet) => { seen.push(wallet); return wallet === first ? 1n : 0n; } };
  assert.equal((await assertNftEligibility({ wallet: first, ...reads })).count, 1n);
  await assert.rejects(assertNftEligibility({ wallet: second, ...reads }), /没有门槛要求的 NFT/);
  assert.deepEqual(seen, [first, second]);
  await assert.rejects(assertNftEligibility({ wallet: first, ...reads, readGate: async () => { throw new Error("test RPC unavailable"); } }), /unavailable/);
});
