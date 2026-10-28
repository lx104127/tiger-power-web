import "./env.mjs";
import "./proxy.mjs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
export const webMode = process.env.PANEL_MODE === "web";
if (webMode && (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY)) process.env.NODE_USE_ENV_PROXY ||= "1";
const dataRoot = process.env.PANEL_DATA_DIR || (webMode ? resolve(root, ".data") : root);

// Production data belongs on a persistent volume, separate from application code.
export function statePath(relative) {
  const path = resolve(dataRoot, relative);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return path;
}
export const walletAddressFile = (acct) => statePath(acct === "2" ? ".wallet2" : ".wallet");
