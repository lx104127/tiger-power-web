// 多账号:账号 1 = 全局 baw(凭证在 Windows 凭据管理器);账号 2 = agentbuy/baw2 里单独装的 baw(凭证加密存在 baw2/.baw)。
// 脚本加 --acct 2 用账号 2,--acct both 两个账号同时跑(各起一个子进程,输出带前缀)。
import "./env.mjs";   // 先读 .env(私有节点 / TG 等)
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { statePath, webMode } from "./runtime.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const bundledEntry = here("./node_modules/@binance/agentic-wallet/dist/index.js");
export const BAW2_ENTRY = process.env.BAW2_ENTRY || (existsSync(bundledEntry) ? bundledEntry : here("./baw2/node_modules/@binance/agentic-wallet/dist/index.js"));
export const BAW2_DIR = process.env.AGENTBUY_BAW2_DIR || (webMode ? statePath("wallets/2/session.json").replace(/[/\\]session\.json$/, "") : here("./baw2/.baw"));

// 解析并移除 --acct;返回 "1" | "2" | "both"
export function takeAcct(args) {
  const i = args.indexOf("--acct");
  if (i < 0) return "1";
  const v = args[i + 1];
  args.splice(i, 2);
  if (!["1", "2", "both"].includes(v)) { console.error("✗ --acct 只能是 1、2 或 both"); process.exit(1); }
  return v;
}

// 账号 1 的 baw:直接用 node 跑全局装的入口文件(走 baw.cmd + 命令壳每次要多 0.5 秒左右)
//   找入口:环境变量 BAW1_ENTRY → %APPDATA%/npm/node_modules(Windows 默认位置)→ npm root -g(慢,只在前两个都没有时跑一次)
function findBaw1() {
  const rel = join("@binance", "agentic-wallet", "dist", "index.js");
  const cands = [process.env.BAW1_ENTRY, bundledEntry, process.env.APPDATA && join(process.env.APPDATA, "npm", "node_modules", rel)];
  for (const c of cands) if (c && existsSync(c)) return c;
  try { const p = join(execSync("npm root -g", { encoding: "utf8" }).trim(), rel); if (existsSync(p)) return p; } catch {}
  return null;
}
export const BAW1_ENTRY = findBaw1();
// 子进程(gang CLI 的 baw-shim)直接用,不用再各自找一遍
if (BAW1_ENTRY && !process.env.BAW1_ENTRY) process.env.BAW1_ENTRY = BAW1_ENTRY;

// 账号对应的 baw 调用方式
// 演示 / 测试用:设了 AGENTBUY_BAW1_DIR 时,账号 1 也用 baw2 那份(凭证存文件、不碰 Windows 凭据管理器),存到指定目录,
// 保证不会覆盖本机真实的账号 1 登录
const BAW1_DIR = process.env.AGENTBUY_BAW1_DIR || (webMode ? statePath("wallets/1/session.json").replace(/[/\\]session\.json$/, "") : null);
function walletInstance(acct) {
  const path = statePath(`wallets/${acct}/instance-id`);
  try { return readFileSync(path, "utf8").trim(); } catch {
    const id = randomUUID();
    try { writeFileSync(path, id, { mode: 0o600, flag: "wx" }); return id; }
    catch (error) { if (error.code === "EEXIST") return readFileSync(path, "utf8").trim(); throw error; }
  }
}
export function bawSpawn(acct, cliArgs) {
  if (!["1", "2"].includes(acct)) throw new Error("账号只能是 1 或 2");
  if (webMode) {
    const entry = acct === "2" ? BAW2_ENTRY : BAW1_ENTRY;
    if (!entry || !existsSync(entry)) throw new Error("钱包 CLI 未安装，请先运行 npm ci");
    return spawn(process.execPath, ["--import", here("./panel/file-wallet-loader.mjs"), entry, ...cliArgs], {
      env: { ...process.env, BINANCE_BAW_DIR: acct === "2" ? BAW2_DIR : BAW1_DIR, BINANCE_INSTANCE_ID: walletInstance(acct) },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  if (acct === "2") return spawn(process.execPath, [BAW2_ENTRY, ...cliArgs], { env: { ...process.env, BINANCE_BAW_DIR: BAW2_DIR } });
  if (BAW1_DIR) return spawn(process.execPath, [BAW2_ENTRY, ...cliArgs], { env: { ...process.env, BINANCE_BAW_DIR: BAW1_DIR } });
  if (BAW1_ENTRY) return spawn(process.execPath, [BAW1_ENTRY, ...cliArgs]);
  return spawn("baw", cliArgs, { shell: true });
}

// --acct both:把当前脚本对两个账号各跑一遍(并行),退出码取最差的
export function runBoth(scriptUrl, args) {
  const runs = ["1", "2"].map((acct) => new Promise((resolve) => {
    const ps = spawn(process.execPath, [fileURLToPath(scriptUrl), ...args, "--acct", acct], { stdio: ["ignore", "pipe", "pipe"] });
    const pipe = (stream, out) => stream.on("data", (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => out.write(`[账号${acct}] ${l}\n`)));
    pipe(ps.stdout, process.stdout); pipe(ps.stderr, process.stderr);
    ps.on("close", (code) => resolve(code ?? 1));
  }));
  Promise.all(runs).then((codes) => process.exit(Math.max(...codes)));
}
