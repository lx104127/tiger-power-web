#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../panel/web-auth.mjs";

const file = fileURLToPath(new URL("../.env", import.meta.url));
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  const url = (await rl.question("网站地址（临时本机使用可填 http://localhost:4400）: ")).trim();
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("请填写网站根地址，不要包含路径、查询参数或账号信息");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) throw new Error("公网地址必须使用 HTTPS");
  // Read passwords without echoing them to the terminal or logs.
  async function hidden(prompt) {
    if (!process.stdin.isTTY) throw new Error("请在交互终端运行 web:setup；自动部署请通过环境变量提供密码哈希");
    process.stdout.write(prompt);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    return new Promise((resolve, reject) => {
      let value = "";
      const finish = (error) => { process.stdin.off("data", onData); process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stdout.write("\n"); error ? reject(error) : resolve(value); };
      const onData = (data) => {
        for (const c of String(data)) {
          if (c === "\u0003") return finish(new Error("已取消"));
          if (c === "\r" || c === "\n") return finish();
          if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
          else if (c >= " ") value += c;
        }
      };
      process.stdin.on("data", onData); process.stdin.resume();
    });
  }
  rl.close();
  const first = await hidden("设置网站密码（至少 12 位，不显示输入）: ");
  const second = await hidden("再次输入网站密码: ");
  if (first !== second) throw new Error("两次密码不一致，未保存");
  const hash = await hashPassword(first);
  let content = ""; try { content = readFileSync(file, "utf8"); } catch {}
  const values = { PANEL_MODE: "web", PANEL_PUBLIC_URL: parsed.origin, PANEL_PASSWORD_HASH: hash };
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    content = re.test(content) ? content.replace(re, line) : content.replace(/\n?$/, "\n") + line + "\n";
  }
  writeFileSync(file, content, { mode: 0o600 }); chmodSync(file, 0o600);
  console.log("已保存网站配置。运行 npm start，然后在浏览器登录网站并连接两个 Binance 钱包。");
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { rl.close(); }
