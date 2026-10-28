#!/usr/bin/env node
import "../env.mjs";
import { temporaryRelay } from "./temporary-relay.mjs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = fileURLToPath(new URL("../", import.meta.url));
const dataDir = resolve(process.env.PANEL_DATA_DIR || resolve(root, ".data"));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const port = Number(process.env.PANEL_PORT || 4410);
const setupKey = randomBytes(32).toString("hex");
const expires = Date.now() + 3600_000;
let child, starting = false, stopping = false;
const relay = temporaryRelay({ port, onFailure: error => console.error(error.message), onReady: async url => {
  if (starting || stopping) return;
  starting = true;
  try {
    writeFileSync(resolve(dataDir, "temporary-origin.json"), JSON.stringify({ url }), { mode: 0o600 });
    if (child) { const done = new Promise(r => child.once("exit", r)); child.kill(); await done; }
    const needsSetup = !existsSync(resolve(dataDir, "website-password.hash")) && !process.env.PANEL_PASSWORD_HASH;
    child = spawn(process.execPath, ["--use-env-proxy", "panel/server.mjs"], { cwd: root, stdio: ["ignore", "ignore", "pipe"], env: {
      ...process.env, PANEL_MODE: "web", PANEL_PUBLIC_URL: url, PANEL_PORT: String(port), PANEL_HOST: "127.0.0.1", PANEL_DATA_DIR: dataDir,
      PANEL_SETUP_KEY: needsSetup ? setupKey : "", PANEL_SETUP_EXPIRES: String(expires), PANEL_BUFFERED_TUNNEL: "1",
    } });
    child.stderr.on("data", () => {}); // Never copy CLI errors or credentials into public relay logs.
    child.on("error", error => console.error(`Application process failed: ${error.code || error.name}`));
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("Application exited during startup");
      try {
        const healthy = await new Promise(resolveHealth => {
          const request = http.get({ hostname: "127.0.0.1", port, path: "/health", headers: { host: new URL(url).host }, agent: new http.Agent() }, response => { response.resume(); resolveHealth(response.statusCode === 200); });
          request.setTimeout(1000, () => request.destroy()); request.on("error", () => resolveHealth(false));
        });
        if (healthy) {
          const entryUrl = needsSetup ? `${url}/login#setup=${setupKey}` : `${url}/login`;
          // The private file contains a single-use setup link, never wallet credentials.
          writeFileSync(resolve(dataDir, "temporary-entry.json"), JSON.stringify({ url, entryUrl, setupExpires: needsSetup ? expires : null }), { mode: 0o600 });
          console.log("Temporary website is running. Private entry information saved.");
          return;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error("Application readiness timed out");
  } finally { starting = false; }
} });
function stop() { if (stopping) return; stopping = true; relay.close(); if (child) { child.once("exit", () => process.exit(0)); child.kill(); } else process.exit(0); }
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
