#!/usr/bin/env node
import "../env.mjs";
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, chownSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Only initialize the private volume as root. The HTTP server, wallet CLI and
// all subsequent files run as the unprivileged image user.
process.umask(0o077);
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
  if (process.env[key] && !["http:", "https:"].includes(new URL(process.env[key]).protocol)) throw new Error("Hosted service supports only HTTP(S) proxy configuration");
}
const publicUrl = new URL(process.env.PANEL_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "");
if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
  throw new Error("Render requires an HTTPS root URL");
}
const port = Number(process.env.PORT || process.env.PANEL_PORT || 10000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid web service port");
const configuredData = process.env.PANEL_DATA_DIR || "/var/tiger-data";
if (!isAbsolute(configuredData)) throw new Error("Private data directory must be absolute");
const dataDir = resolve(configuredData);
const sourceRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
if (dataDir === "/" || dataDir === sourceRoot || sourceRoot.startsWith(dataDir + sep)) throw new Error("Private data directory must be separate from the application root");
if (existsSync(dataDir) && lstatSync(dataDir).isSymbolicLink()) throw new Error("Private data directory cannot be a symbolic link");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if (realpathSync(dataDir) !== dataDir) throw new Error("Private data directory must use its real path");
if (process.env.PANEL_REQUIRE_PERSISTENT_DATA !== "0") {
  const unescape = value => value.replace(/\\([0-7]{3})/g, (_, digits) => String.fromCharCode(parseInt(digits, 8)));
  const mounted = readFileSync("/proc/self/mountinfo", "utf8").split("\n").some(line => {
    const mount = unescape(line.split(" ")[4] || "");
    const filesystem = line.split(" - ")[1]?.split(" ")[0];
    return mount === dataDir && filesystem && !["tmpfs", "ramfs"].includes(filesystem);
  });
  if (!mounted) throw new Error("Persistent disk is required at PANEL_DATA_DIR; attach the Render disk before starting");
}
if (process.getuid?.() === 0) {
  chownSync(dataDir, 1000, 1000);
  chmodSync(dataDir, 0o700);
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
} else if (lstatSync(dataDir).uid === process.getuid?.()) chmodSync(dataDir, 0o700);
accessSync(dataDir, constants.R_OK | constants.W_OK | constants.X_OK);

Object.assign(process.env, {
  PANEL_MODE: "web", PANEL_HOST: "0.0.0.0", PANEL_PORT: String(port),
  PANEL_PUBLIC_URL: publicUrl.origin, PANEL_DATA_DIR: dataDir,
  PANEL_HOSTED_HEALTH: "1",
});
const passwordFile = resolve(dataDir, "website-password.hash");
const setupFile = resolve(dataDir, "website-setup.json");
if (existsSync(passwordFile)) accessSync(passwordFile, constants.R_OK);
if (!process.env.PANEL_PASSWORD_HASH && !existsSync(passwordFile)) {
  let setup;
  try { setup = JSON.parse(readFileSync(setupFile, "utf8")); } catch {}
  if (!setup || setup.origin !== publicUrl.origin || !/^[a-f0-9]{64}$/.test(setup.key || "") || !Number.isFinite(setup.expiresAt) || setup.expiresAt <= Date.now() || setup.expiresAt > Date.now() + 3600_000) {
    setup = { origin: publicUrl.origin, key: randomBytes(32).toString("hex"), expiresAt: Date.now() + 3600_000 };
    writeFileSync(setupFile, JSON.stringify(setup), { mode: 0o600 });
  }
  chmodSync(setupFile, 0o600);
  process.env.PANEL_SETUP_KEY = setup.key;
  process.env.PANEL_SETUP_EXPIRES = String(setup.expiresAt);
  console.log("Website initialization is ready. In the private Render Shell, run: node scripts/hosted-entry.mjs");
} else {
  if (existsSync(setupFile)) unlinkSync(setupFile);
  delete process.env.PANEL_SETUP_KEY;
  delete process.env.PANEL_SETUP_EXPIRES;
}
await import("../panel/server.mjs");
