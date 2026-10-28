import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const hostname = "hosted-test.onrender.com";
const origin = `https://${hostname}`;
async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function request(port, path, { host = hostname, method = "GET", input, cookie, requestOrigin = origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host };
    if (input) Object.assign(headers, { origin: requestOrigin, "content-type": "application/json" });
    if (cookie) headers.cookie = cookie;
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers, agent: new http.Agent() }, res => {
      let body = "";
      res.on("data", data => body += data);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.setTimeout(1500, () => req.destroy(new Error("test request timed out")));
    req.end(input ? JSON.stringify(input) : undefined);
  });
}
async function start(data, { persistentRequired = false } = {}) {
  const port = await freePort();
  const env = { ...process.env, TIGER_TEST: "1", RENDER_EXTERNAL_URL: origin, PANEL_PUBLIC_URL: "", PORT: String(port), PANEL_PORT: "invalid", PANEL_DATA_DIR: data, PANEL_PASSWORD_HASH: "", PANEL_SETUP_KEY: "", PANEL_SETUP_EXPIRES: "", PANEL_REQUIRE_PERSISTENT_DATA: persistentRequired ? "1" : "0", PANEL_BACKGROUND: "0" };
  const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("./network.mjs", import.meta.url)), "scripts/start-render.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => output += data);
  child.stderr.on("data", data => output += data);
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise(resolve => child.once("exit", resolve));
    child.kill(); await done;
  };
  for (let n = 0; n < 80; n++) {
    if (child.exitCode !== null) return { child, output: () => output, stop, env, port };
    try {
      if ((await request(port, "/health")).status === 200) return { child, output: () => output, stop, env, port };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await stop(); throw new Error("hosted fixture did not become ready");
}

test("hosted entry retains the password across restarts and limits probe exceptions to read-only health", async t => {
  const data = await mkdtemp(join(tmpdir(), "tiger-hosted-test-"));
  let app;
  t.after(async () => { await app?.stop(); await rm(data, { recursive: true, force: true }); });
  app = await start(data);
  assert.equal(app.child.exitCode, null);
  const setup = JSON.parse(await readFile(join(data, "website-setup.json"), "utf8"));
  assert.match(setup.key, /^[a-f0-9]{64}$/);
  assert.equal(setup.origin, origin);
  assert.ok(setup.expiresAt > Date.now() && setup.expiresAt <= Date.now() + 3600_000);
  assert.equal((await stat(join(data, "website-setup.json"))).mode & 0o777, 0o600);
  assert.ok(!app.output().includes(setup.key));
  const entry = spawnSync(process.execPath, ["scripts/hosted-entry.mjs"], { cwd: root, env: app.env, encoding: "utf8" });
  assert.equal(entry.status, 0);
  assert.equal(entry.stdout.trim(), `${origin}/login#setup=${setup.key}`);
  assert.equal((await request(app.port, "/health", { host: "internal-probe.invalid" })).status, 200);
  const head = await request(app.port, "/health", { host: "internal-probe.invalid", method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.body, "");
  assert.equal((await request(app.port, "/api/wallets", { host: "internal-probe.invalid" })).status, 403);
  assert.equal((await request(app.port, "/health", { method: "POST", host: "internal-probe.invalid", input: {} })).status, 403);
  assert.equal((await request(app.port, "/health?extra=1", { host: "internal-probe.invalid" })).status, 403);
  assert.equal((await request(app.port, "/api/wallets")).status, 401);
  const input = { key: setup.key, password: "automated-hosted-test-password", confirmPassword: "automated-hosted-test-password" };
  assert.equal((await request(app.port, "/auth/setup", { method: "POST", input, requestOrigin: "https://wrong.invalid" })).status, 403);
  const initialLogin = await request(app.port, "/auth/setup", { method: "POST", input });
  assert.equal(initialLogin.status, 200);
  assert.ok(initialLogin.headers["set-cookie"][0].includes("Secure"));
  const hash = await readFile(join(data, "website-password.hash"), "utf8");
  assert.match(hash, /^scrypt:/); assert.ok(!hash.includes(input.password));
  await app.stop();
  app = await start(data);
  assert.equal(app.child.exitCode, null);
  assert.equal(await readFile(join(data, "website-password.hash"), "utf8"), hash);
  await assert.rejects(readFile(join(data, "website-setup.json")), { code: "ENOENT" });
  const loginEntry = spawnSync(process.execPath, ["scripts/hosted-entry.mjs"], { cwd: root, env: app.env, encoding: "utf8" });
  assert.equal(loginEntry.status, 0); assert.equal(loginEntry.stdout.trim(), `${origin}/login`);
  assert.equal((await request(app.port, "/auth/setup", { method: "POST", input })).status, 409);
  assert.equal((await request(app.port, "/auth/login", { method: "POST", input: { password: input.password } })).status, 200);
});

test("hosted entry refuses a data directory without an attached persistent disk", async t => {
  const data = await mkdtemp(join(tmpdir(), "tiger-missing-disk-"));
  const app = await start(data, { persistentRequired: true });
  t.after(async () => { await app.stop(); await rm(data, { recursive: true, force: true }); });
  assert.notEqual(app.child.exitCode, 0);
  assert.match(app.output(), /Persistent disk is required/);
  await assert.rejects(readFile(join(data, "website-setup.json")), { code: "ENOENT" });
});
