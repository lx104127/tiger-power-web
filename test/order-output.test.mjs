import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { consumeOrderLines, redactOrderOutput } from "../panel/order-output.mjs";
test("split UTF-8 output retains complete confirmation and transaction hash lines", async () => {
  const input = new PassThrough(), lines = [];
  consumeOrderLines(input, line => lines.push(line));
  const hash = "0x" + "a".repeat(64);
  const bytes = Buffer.from(`买入 已提交 ${hash}\n状态待核对`);
  for (let index = 0; index < bytes.length; index += 2) input.write(bytes.subarray(index, index + 2));
  await new Promise(resolve => { input.on("end", resolve); input.end(); });
  assert.deepEqual(lines, [`买入 已提交 ${hash}`, "状态待核对"]);
});
test("credential fields and private RPC keys are redacted while public transaction hashes remain", () => {
  const line = redactOrderOutput('clientId="fixture-client-value" sessionToken=fixture-session-value Bearer fixture-bearer-value https://rpc.invalid/v2/fixture_private_rpc_key_123456 txHash=0x' + 'a'.repeat(64));
  for (const secret of ["fixture-client-value", "fixture-session-value", "fixture-bearer-value", "fixture_private_rpc_key_123456"]) assert.ok(!line.includes(secret));
  assert.ok(line.includes("0x" + "a".repeat(64)));
});
