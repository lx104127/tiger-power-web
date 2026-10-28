import { statePath } from "../runtime.mjs";
// 扫链页的补充数据:代币图片(本机缓存)+ GMGN trenches(每分钟最多一次)。
//   图片:各平台自己的来源优先 —— Gang V2 用 gang.fun 的 logoUrl,four 用 four.meme 接口的 image,
//         ID Agent 用合约里的 IPFS 元数据(走 Pinata 网关),GMGN 收录的币用它的 logo;取到一次就存盘,以后只读本地。
//   GMGN:用 gmgn-cli 自己的 key(gmgn-cli 的默认配置位置),账户级限流 —— 每 3 分钟最多调一次 trenches,且只在扫链页开着时调;
//         只在每分钟的第 35–50 秒、且不在 5 的整数分钟调(避开同一个 key 上别的定时任务);遇到限流整体停 5 分钟。没配 key 就没有 GMGN 数据。
import { spawn } from "node:child_process";
import net from "node:net";
import { lookup as dnsLookupCb } from "node:dns";
import { promisify } from "node:util";
const dnsLookup = promisify(dnsLookupCb);
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const IMG_DIR = statePath("panel/img-cache/") + "/";
const LOGO_INDEX = statePath("panel/img-cache/index.json");
const PINATA = "https://gateway.pinata.cloud/ipfs/";
mkdirSync(IMG_DIR, { recursive: true });

// ---------- GMGN trenches ----------
const gmgn = { at: 0, pausedUntil: 0, running: false, map: new Map(), calls: 0, limited: 0, lastError: null };
function okWindow() {
  const d = new Date();
  return d.getSeconds() >= 35 && d.getSeconds() <= 50 && d.getMinutes() % 5 !== 0;
}
export function kickGmgn() {
  if (gmgn.running || Date.now() < gmgn.pausedUntil || Date.now() - gmgn.at < 180_000 || !okWindow()) return;
  const entry = process.env.GMGN_CLI_ENTRY;
  if (!entry || !isAbsolute(entry) || !existsSync(entry)) return;
  gmgn.running = true;
  gmgn.calls++;
  const ps = spawn(process.execPath, [entry, "market", "trenches", "--chain", "bsc", "--limit", "80", "--raw"], { windowsHide: true });
  let out = "", err = "";
  ps.stdout.on("data", (d) => (out += d));
  ps.stderr.on("data", (d) => (err += d));
  ps.on("close", () => {
    gmgn.running = false;
    gmgn.at = Date.now();
    if (/429|rate limit|banned/i.test(err + out.slice(0, 300))) {
      gmgn.limited++; gmgn.pausedUntil = Date.now() + 5 * 60_000; gmgn.lastError = (err || out).slice(0, 200);
      console.error(`[gmgn] 被限流,停 5 分钟:${gmgn.lastError}`);
      return;
    }
    try {
      const j = JSON.parse(out), root = j.data ?? j, map = new Map();
      for (const k of Object.keys(root)) for (const x of root[k] ?? []) map.set(String(x.address).toLowerCase(), x);
      gmgn.map = map; gmgn.lastError = null;
      for (const [ca, x] of map) if (x.logo && !logos[ca]) logos[ca] = { url: x.logo };   // 顺手记下图片地址
    } catch { gmgn.lastError = (err || out).slice(0, 200); }
  });
}
export const gmgnInfo = (ca) => gmgn.map.get(ca);
export const gmgnStatus = () => ({ calls: gmgn.calls, limited: gmgn.limited, pausedS: Math.max(0, Math.round((gmgn.pausedUntil - Date.now()) / 1000)), lastAt: gmgn.at || null, lastError: gmgn.lastError, size: gmgn.map.size });

// ---------- 图片 ----------
let logos = {};
try { logos = JSON.parse(readFileSync(LOGO_INDEX, "utf8")); } catch {}
const saveIndex = () => writeFileSync(LOGO_INDEX, JSON.stringify(logos));
const pending = new Map();
let active = 0;
const queue = [];
const limit = (fn) => new Promise((res, rej) => { queue.push([fn, res, rej]); pump(); });
function pump() {
  while (active < 3 && queue.length) {
    const [fn, res, rej] = queue.shift();
    active++;
    fn().then(res, rej).finally(() => { active--; pump(); });
  }
}
const cidUrl = (s) => (!s ? null : s.startsWith("http") ? s : PINATA + s.replace(/^ipfs:\/\//, "").replace(/^ipfs\//, ""));
const getJson = async u => { try { const bytes = await safeDownload(u); return bytes ? JSON.parse(bytes.toString("utf8")) : null; } catch { return null; } };

// 找图片地址:meta 来自扫链数据 { platform, uri }
async function resolveUrl(ca, meta) {
  if (logos[ca]?.url) return logos[ca].url;
  let url = null;
  if (["gangv1", "gangv2", "gangv3"].includes(meta?.platform)) {
    const d = await getJson(`https://gang.fun/api/tokens/${ca}`);
    url = d?.logoUrl || d?.logoURI || null;
  } else if (meta?.platform === "four") {
    const d = await getJson(`https://four.meme/meme-api/v1/private/token/get/v2?address=${ca}`);
    url = d?.data?.image || null;
  } else if (meta?.platform === "idagent" && meta.uri) {
    const m = await getJson(cidUrl(meta.uri));
    url = cidUrl(m?.image);
  }
  logos[ca] = { url, tried: Date.now() };
  saveIndex();
  return url;
}
// 图片地址来自代币的元数据(发币的人自己填的),不能信:
//   只许 https;每次请求(包括跳转后的地址)都先解析域名,落在本机 / 内网 / 保留地址就拒绝;最多跟 3 次跳转;
//   边下边数字节,超过 3 MB 立刻中断(不先整个下载完再判断)
const IMG_MAX = 3 * 1024 * 1024;
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) {
    const tail = v.slice(7);
    if (net.isIPv4(tail)) return privateIp(tail);
    const halves = tail.split(":");
    if (halves.length !== 2 || halves.some(h => !/^[0-9a-f]{1,4}$/.test(h))) return true;
    const [a, b] = halves.map(h => parseInt(h, 16));
    return privateIp(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
  }
  return !/^[23][0-9a-f]{0,3}:/.test(v) || v.startsWith("2001:db8:");
}
async function publicHttpsUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = net.isIP(host) ? [host] : (await dnsLookup(host, { all: true }).catch(() => [])).map((x) => x.address);
  if (!ips.length || ips.some(privateIp)) return null;
  return u;
}
export async function safeDownload(raw) {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await publicHttpsUrl(url);
    if (!u) return null;
    const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(20000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { try { await r.body?.cancel(); } catch {} url = new URL(r.headers.get("location"), u).href; continue; }
    if (!r.ok || !r.body) { try { await r.body?.cancel(); } catch {} return null; }
    if (Number(r.headers.get("content-length") || 0) > IMG_MAX) { try { await r.body.cancel(); } catch {} return null; }
    const chunks = [];
    let n = 0;
    for await (const c of r.body) {
      n += c.length;
      if (n > IMG_MAX) { try { await r.body.cancel(); } catch {} return null; }
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
  }
  return null;
}
function imageType(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;   // 不认 svg / html 等,避免把网页当图片回给浏览器
}
// 返回 { type, body } 或 null(没有图)
export async function tokenImage(ca, meta) {
  const file = IMG_DIR + ca + ".bin";
  if (existsSync(file)) {
    const body = readFileSync(file);
    return { type: imageType(body), body };
  }
  if (logos[ca] && !logos[ca].url && Date.now() - (logos[ca].tried ?? 0) < 30 * 60_000) return null;   // 半小时内找过没有,就别再找
  if (pending.has(ca)) return pending.get(ca);
  const p = limit(async () => {
    const url = await resolveUrl(ca, meta);
    if (!url) return null;
    const body = await safeDownload(url).catch(() => null);
    if (!body) return null;
    const type = imageType(body);
    if (!type) return null;
    writeFileSync(file, body);
    return { type, body };
  }).finally(() => pending.delete(ca));
  pending.set(ca, p);
  return p;
}
