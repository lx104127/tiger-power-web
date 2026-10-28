import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Gang trading module loads its locked local CLI without global npm and reuses the terminal RPC", async t => {
  const dir = await mkdtemp(join(tmpdir(), "tiger-gang-dependency-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = `
    await import('./gang/gangcore.mjs');
    const chain = await import('./node_modules/@gangfun/cli/src/chain.js');
    const required = ['tokenInfo','quoteBuy','quoteSell','resolvePad','isAgent','allowance','balanceOf','parseEther','fmt','fmtTok'];
    if (!required.every(name => typeof chain[name] === 'function') || !chain.calldata) throw new Error('Incompatible Gang CLI');
    if (chain.CONFIG.rpc !== process.env.BSC_RPC) throw new Error('Gang RPC does not match terminal RPC');
    console.log('local CLI ready');
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 15000,
    env: { ...process.env, PATH: dir, PANEL_MODE: "web", PANEL_DATA_DIR: dir, GANG_CLI_CHAIN: "", GANG_RPC_URL: "", BSC_RPC: "http://127.0.0.1:9876" },
  });
  assert.equal(stdout.trim(), "local CLI ready");
  assert.equal(stderr, "");
});
