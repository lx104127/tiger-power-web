import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const TTL = 12 * 60 * 60_000;
const IDLE = 30 * 60_000;
const WINDOW = 15 * 60_000;
const COOKIE = "tiger_session";
export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) throw new Error("网站密码需为 12–256 个字符");
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt, 32);
  return `scrypt:${salt}:${key.toString("hex")}`;
}
function validHash(hash) { return /^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/.test(hash || ""); }
async function verifyPassword(password, hash) {
  if (typeof password !== "string" || password.length > 256) return false;
  const [, salt, expected] = hash.split(":");
  return timingSafeEqual(await derive(password, salt, 32), Buffer.from(expected, "hex"));
}
const digest = (value) => createHash("sha256").update(value).digest("hex");
function cookieValue(req) {
  const match = (req.headers.cookie || "").split(";").map((x) => x.trim()).find((x) => x.startsWith(`${COOKIE}=`));
  const value = match?.slice(COOKIE.length + 1) || "";
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export function createAccess({ env = process.env, port = 4400, now = Date.now, persistPasswordHash } = {}) {
  const web = env.PANEL_MODE === "web";
  let passwordHash = env.PANEL_PASSWORD_HASH;
  let setupKey = env.PANEL_SETUP_KEY;
  const setupExpires = Number(env.PANEL_SETUP_EXPIRES);
  const setupAllowed = /^[a-f0-9]{64}$/.test(setupKey || "") && setupExpires > now() && setupExpires <= now() + 3600_000 && typeof persistPasswordHash === "function";
  let settingUp = false;
  if (env.PANEL_MODE && !["local", "web"].includes(env.PANEL_MODE)) throw new Error("PANEL_MODE 必须为 local 或 web");
  let origin = null;
  if (web) {
    if (!validHash(passwordHash) && !setupAllowed) throw new Error("请先运行 npm run web:setup 设置网站密码");
    try { origin = new URL(env.PANEL_PUBLIC_URL); } catch { throw new Error("请设置 PANEL_PUBLIC_URL 为网站完整地址"); }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if ((origin.protocol !== "https:" && !(loopback && origin.protocol === "http:")) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new Error("PANEL_PUBLIC_URL 必须为 HTTPS 根地址（本机测试可用 HTTP）");
    }
  }
  const sessions = new Map(), attempts = new Map();
  const secure = origin?.protocol === "https:";
  const cookie = (value, age) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? "; Secure" : ""}`;
  const prune = () => {
    for (const [key, value] of sessions) if (value.expires <= now() || value.seen + IDLE <= now()) sessions.delete(key);
    for (const [key, value] of attempts) if (value.until <= now()) attempts.delete(key);
  };
  function checkOrigin(req) {
    const host = req.headers.host;
    if (web ? host !== origin.host : ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) throw new Error("Host 不允许");
    const expected = web ? origin.origin : `http://${host}`;
    if ((req.headers.origin && req.headers.origin !== expected) || (web && req.method === "POST" && req.headers.origin !== expected)) throw new Error("Origin 不允许");
    if (web && req.method === "POST" && !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) throw new Error("请使用 JSON 请求");
  }
  function session(req) {
    if (!web) return null;
    prune();
    const value = cookieValue(req);
    const s = value ? sessions.get(digest(value)) : null;
    if (s) s.seen = now();
    return s || null;
  }
  async function signin(req, res, password) {
    if (!validHash(passwordHash)) return { status: 403, data: { error: "请通过私人初始化链接设置网站密码" } };
    prune();
    const ip = req.socket.remoteAddress || "unknown";
    const a = attempts.get(ip) || { count: 0, until: now() + WINDOW };
    if (a.count >= 5) return { status: 429, data: { error: "尝试过多，请 15 分钟后重试" }, retryAfter: Math.ceil((a.until - now()) / 1000) };
    a.count++; attempts.set(ip, a);
    if (!(await verifyPassword(password, passwordHash))) return { status: 401, data: { error: "网站密码不正确" } };
    attempts.delete(ip);
    const old = cookieValue(req);
    if (old) sessions.delete(digest(old));
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString("hex");
    sessions.set(digest(token), { csrf: randomBytes(24).toString("hex"), expires: now() + TTL, seen: now() });
    res.setHeader("Set-Cookie", cookie(token, TTL / 1000));
    return { status: 200, data: { ok: true } };
  }
  function signout(req, res) {
    const token = cookieValue(req);
    if (token) sessions.delete(digest(token));
    res.setHeader("Set-Cookie", cookie("", 0));
  }
  async function setup(req, res, input) {
    if (validHash(passwordHash) || settingUp) return { status: 409, data: { error: "网站密码已经设置，请直接登录" } };
    if (!setupAllowed || now() >= setupExpires) return { status: 410, data: { error: "初始化链接已过期，请重新生成" } };
    if (!/^[a-f0-9]{64}$/.test(input.key || "") || !timingSafeEqual(Buffer.from(input.key, "hex"), Buffer.from(setupKey, "hex"))) return { status: 403, data: { error: "初始化链接无效" } };
    if (input.password !== input.confirmPassword) return { status: 400, data: { error: "两次密码不一致" } };
    settingUp = true;
    try {
      const hash = await hashPassword(input.password);
      await persistPasswordHash(hash);
      passwordHash = hash; setupKey = null;
      return signin(req, res, input.password);
    } finally { settingUp = false; }
  }
  return { web, checkOrigin, session, signin, signout, setup };
}
