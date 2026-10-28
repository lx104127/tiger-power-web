#!/usr/bin/env node
// Run explicitly in the owner's private hosting shell. Never run this helper
// in the build/start command: the setup capability must not enter public logs.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const data = resolve(process.env.PANEL_DATA_DIR || "/var/tiger-data");
const url = new URL(process.env.PANEL_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "");
if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid website URL");
if (process.env.PANEL_PASSWORD_HASH || existsSync(resolve(data, "website-password.hash"))) {
  console.log(`${url.origin}/login`);
} else {
  const setup = JSON.parse(readFileSync(resolve(data, "website-setup.json"), "utf8"));
  if (setup.origin !== url.origin || !/^[a-f0-9]{64}$/.test(setup.key || "") || setup.expiresAt <= Date.now()) throw new Error("Initialization link expired; restart the service to generate a new one");
  console.log(`${url.origin}/login#setup=${setup.key}`);
}
