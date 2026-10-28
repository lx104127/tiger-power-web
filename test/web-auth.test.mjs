import test from "node:test";
import assert from "node:assert/strict";
import { createAccess, hashPassword } from "../panel/web-auth.mjs";

test("web mode requires a password and HTTPS outside loopback", async () => {
  assert.throws(() => createAccess({ env: { PANEL_MODE: "web" } }), /web:setup/);
  const hash = await hashPassword("test-password-123456");
  assert.throws(() => createAccess({ env: { PANEL_MODE: "web", PANEL_PASSWORD_HASH: hash, PANEL_PUBLIC_URL: "http://example.com" } }), /HTTPS/);
  await assert.rejects(hashPassword("short"), /12/);
});
test("cookies are protected, CSRF is unique, idle/absolute expiry and logout work", async () => {
  let time = Date.now();
  const env = { PANEL_MODE: "web", PANEL_PASSWORD_HASH: await hashPassword("test-password-123456"), PANEL_PUBLIC_URL: "https://trade.example.com" };
  const access = createAccess({ env, now: () => time });
  const req = { headers: { host: "trade.example.com", origin: "https://trade.example.com", "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" }, method: "POST" };
  let cookie; const res = { setHeader: (_, value) => cookie = value };
  assert.equal((await access.signin(req, res, "wrong")).status, 401);
  assert.equal((await access.signin(req, res, "test-password-123456")).status, 200);
  assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.match(cookie, /Secure/);
  req.headers.cookie = cookie.split(";")[0];
  const s = access.session(req); assert.match(s.csrf, /^[a-f0-9]{48}$/);
  time += 31 * 60_000; assert.equal(access.session(req), null);
  await access.signin(req, res, "test-password-123456"); req.headers.cookie = cookie.split(";")[0];
  time += 12 * 3600_000; assert.equal(access.session(req), null);
  await access.signin(req, res, "test-password-123456"); req.headers.cookie = cookie.split(";")[0];
  assert.ok(access.session(req)); access.signout(req, res); assert.equal(access.session(req), null);
  assert.throws(() => access.checkOrigin({ ...req, headers: { ...req.headers, origin: "https://evil.example" } }), /Origin/);
  assert.throws(() => access.checkOrigin({ ...req, headers: { ...req.headers, host: "evil.example" } }), /Host/);
});
test("incorrect passwords are rate limited", async () => {
  const access = createAccess({ env: { PANEL_MODE: "web", PANEL_PASSWORD_HASH: await hashPassword("test-password-123456"), PANEL_PUBLIC_URL: "https://trade.example.com" } });
  const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } }, res = { setHeader() {} };
  for (let i = 0; i < 5; i++) assert.equal((await access.signin(req, res, "wrong")).status, 401);
  assert.equal((await access.signin(req, res, "test-password-123456")).status, 429);
});
test("private initialization is single-use, expires and persists only a password hash", async () => {
  let saved, time = Date.now();
  const env = { PANEL_MODE: "web", PANEL_PUBLIC_URL: "https://trade.example.com", PANEL_SETUP_KEY: "b".repeat(64), PANEL_SETUP_EXPIRES: String(time + 60000) };
  const access = createAccess({ env, now: () => time, persistPasswordHash: hash => { saved = hash; } });
  const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } }, res = { setHeader() {} };
  assert.equal((await access.signin(req, res, "fixture-password-123")).status, 403);
  const input = { key: "b".repeat(64), password: "fixture-password-123", confirmPassword: "fixture-password-123" };
  assert.equal((await access.setup(req, res, { ...input, key: "c".repeat(64) })).status, 403);
  assert.equal((await access.setup(req, res, { ...input, confirmPassword: "wrong" })).status, 400);
  assert.equal((await access.setup(req, res, input)).status, 200);
  assert.match(saved, /^scrypt:/); assert.ok(!saved.includes(input.password));
  assert.equal((await access.setup(req, res, input)).status, 409);
  const expires = createAccess({ env, now: () => time, persistPasswordHash() {} });
  time += 60001; assert.equal((await expires.setup(req, res, input)).status, 410);
});
