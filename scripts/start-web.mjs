#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const file = fileURLToPath(new URL("../.env", import.meta.url));
let configured = !!process.env.PANEL_PASSWORD_HASH;
try { configured ||= /^PANEL_PASSWORD_HASH=scrypt:/m.test(readFileSync(file, "utf8")); } catch {}
if (!configured) {
  const result = spawnSync(process.execPath, ["scripts/web-setup.mjs"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
await import("../env.mjs");
if (!process.env.PANEL_PUBLIC_URL) { console.error("缺少网站地址，请运行 npm run web:setup"); process.exit(1); }
const child = spawn(process.execPath, ["--use-env-proxy", "panel/server.mjs"], {
  cwd: root, stdio: "inherit", env: { ...process.env, PANEL_MODE: "web" },
});
console.log(`浏览器打开你配置的网站地址：${process.env.PANEL_PUBLIC_URL}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => process.exit(code ?? 1));
child.on("error", error => { console.error(error.message); process.exit(1); });
