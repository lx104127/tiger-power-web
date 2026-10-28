import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixture, testPassword } from "./helpers.mjs";

const app = await startFixture();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] });
const failures = [];
try {
  await mkdir("artifacts", { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => failures.push(error.message));
  // Keep market polling deterministic and offline; wallet endpoints still use
  // the real server and its isolated, explicitly test-only CLI process.
  await page.route("**/api/scan", route => route.fulfill({ json: { tokens: [], errors: [] } }));
  await page.goto(app.origin);
  await page.locator("#password").fill("incorrect-password");
  await page.locator("#submit").click();
  await page.locator("#error").filter({ hasText: "网站密码不正确" }).waitFor();
  await page.locator("#password").fill(""); await page.locator("#error").evaluate(el => el.textContent = "");
  await page.screenshot({ path: "artifacts/web-login-desktop.png", fullPage: true });
  await page.locator("#password").fill(testPassword); await page.locator("#submit").click();
  await page.waitForURL(app.origin + "/");
  await page.locator('#wchips [data-login="1"]').waitFor();
  await page.locator('#wchips [data-login="2"]').waitFor();
  await page.locator('#wchips [data-login="1"]').click();
  await page.locator("#lmPair").filter({ hasText: "TEST01" }).waitFor();
  assert.ok(await page.locator("#lmOpen").getAttribute("href"));
  await page.locator("#lmCopy").waitFor();
  await page.locator("#loginModal").waitFor({ state: "hidden" });
  await page.locator('#wchips [data-login="2"]').click();
  await page.locator("#lmPair").filter({ hasText: "TEST02" }).waitFor();
  await page.locator("#loginModal").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelectorAll("#wchips .dot.on").length === 2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 1440), "Desktop terminal overflows viewport");
  await page.screenshot({ path: "artifacts/terminal-desktop.png", fullPage: true });
  // A pending confirmation timeout is unresolved, never a confirmed on-chain
  // failure or success. This response is intercepted; no wallet command runs.
  let interceptedTrades = 0, tradeScenario = "pending";
  await page.route("**/api/run", route => {
    interceptedTrades++;
    if (tradeScenario === "network") return route.abort("failed");
    if (tradeScenario === "rejected") return route.fulfill({ status: 400, json: { error: "fixture validation rejection" } });
    return route.fulfill({ contentType: "text/plain", body: "⏳ 状态待核对:等待 App 确认超时，请核对链上记录\n__DONE__ 2\n" });
  });
  const exerciseOrder = () => page.evaluate(async () => {
    const previous = { cur, renderTrade, load, loadTrades, loadWallets, oneClick: document.getElementById("oneClick").checked };
    try {
      cur = { ca: "0x3333333333333333333333333333333333333333", symbol: "TEST", platform: "gangv2", platformLabel: "Gang V2", stage: "inner" };
      renderTrade = () => {}; load = () => {}; loadTrades = () => {}; loadWallets = () => {};
      document.getElementById("oneClick").checked = true;
      document.getElementById("appConfirm").checked = true;
      await order("sell", "100", "1");
    } finally {
      cur = previous.cur; renderTrade = previous.renderTrade; load = previous.load; loadTrades = previous.loadTrades; loadWallets = previous.loadWallets;
      document.getElementById("oneClick").checked = previous.oneClick;
    }
  });
  await exerciseOrder();
  assert.equal(interceptedTrades, 1);
  assert.equal(await page.locator("#ordS").textContent(), "状态待核对");
  assert.ok((await page.locator("#ordL").textContent()).includes("Binance App"));
  tradeScenario = "network"; await exerciseOrder();
  assert.equal(await page.locator("#ordS").textContent(), "状态待核对");
  tradeScenario = "rejected"; await exerciseOrder();
  assert.equal(await page.locator("#ordS").textContent(), "失败");
  assert.equal(interceptedTrades, 3);
  await page.getByRole("button", { name: "锁定网站", exact: true }).click();
  await page.waitForURL(app.origin + "/login");
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  mobile.on("pageerror", error => failures.push(error.message));
  await mobile.route("**/api/scan", route => route.fulfill({ json: { tokens: [], errors: [] } }));
  await mobile.goto(app.origin + "/login");
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= 390 && innerWidth <= 390));
  await mobile.screenshot({ path: "artifacts/web-login-mobile.png", fullPage: true });
  await mobile.locator("#password").fill(testPassword); await mobile.locator("#submit").click();
  await mobile.waitForURL(app.origin + "/");
  await mobile.waitForFunction(() => !!document.querySelector(".home"));
  await mobile.screenshot({ path: "artifacts/terminal-mobile.png", fullPage: true });
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= 390 && innerWidth <= 390), "Mobile terminal overflows viewport");
  assert.deepEqual(failures, []);
  const setupApp = await startFixture({ bootstrap: true });
  try {
    const setupPage = await browser.newPage();
    setupPage.on("pageerror", error => failures.push(error.message));
    await setupPage.route("**/api/scan", route => route.fulfill({ json: { tokens: [], errors: [] } }));
    await setupPage.goto(`${setupApp.origin}/login#setup=${"b".repeat(64)}`);
    await setupPage.getByRole("heading", { name: "设置你的访问密码" }).waitFor();
    await setupPage.locator("#password").fill(testPassword);
    await setupPage.locator("#confirm-password").fill(testPassword);
    await setupPage.locator("#submit").click();
    await setupPage.waitForURL(setupApp.origin + "/");
    await setupPage.locator('#wchips [data-login="2"]').waitFor();
    const { readFile } = await import("node:fs/promises");
    const hash = await readFile(setupApp.data + "/website-password.hash", "utf8");
    assert.match(hash, /^scrypt:/); assert.ok(!hash.includes(testPassword));
    await setupPage.close();
  } finally { await setupApp.stop(); }
  assert.deepEqual(failures, []);
  console.log("Browser checks passed: website login, two wallet sign-ins, website lock, desktop/mobile layouts, no page errors. Wallet responses were test fixtures; no real transaction was sent.");
} finally { await browser.close(); await app.stop(); }
