import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../panel/web-auth.mjs";
export const testPassword = "only-for-automated-tests-42";
export async function startFixture({ bootstrap = false } = {}) {
  const data = await mkdtemp(join(tmpdir(), "tiger-web-test-"));
  const rpc = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const input = JSON.parse(body);
    const answer = x => ({ jsonrpc: "2.0", id: x.id, result: x.method === "eth_chainId" ? "0x38" : "0x0" });
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(input) ? input.map(answer) : answer(input)));
  });
  await new Promise(r => rpc.listen(0, "127.0.0.1", r));
  const free = http.createServer(); await new Promise(r => free.listen(0, "127.0.0.1", r));
  const port = free.address().port; await new Promise(r => free.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const fixture = fileURLToPath(new URL("./fixture-baw.mjs", import.meta.url));
  const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("./network.mjs", import.meta.url)), "panel/server.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, TIGER_TEST: "1", PANEL_MODE: "web", PANEL_PUBLIC_URL: origin, PANEL_PASSWORD_HASH: bootstrap ? "" : await hashPassword(testPassword), PANEL_SETUP_KEY: bootstrap ? "b".repeat(64) : "", PANEL_SETUP_EXPIRES: String(Date.now() + 1800_000), PANEL_PORT: String(port), PANEL_HOST: "127.0.0.1", PANEL_DATA_DIR: data, PANEL_BACKGROUND: "0", BAW1_ENTRY: fixture, BAW2_ENTRY: fixture, BSC_RPC: `http://127.0.0.1:${rpc.address().port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b);
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
    try { if ((await fetch(origin + "/health")).ok) break; } catch {}
    if (i === 79) throw new Error(`Server did not start: ${output}`);
    await new Promise(r => setTimeout(r, 50));
  }
  return { origin, data, child, async stop() { const done = new Promise(r => child.once("exit", r)); child.kill(); await done; await new Promise(r => rpc.close(r)); await rm(data, { recursive: true, force: true }); } };
}
