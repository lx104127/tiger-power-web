import { fileURLToPath } from "node:url";
const AGENTBUY = fileURLToPath(new URL("../", import.meta.url));
const SHARE = AGENTBUY;
export function route(d, action, acct, arg, appConfirm = false) {
  if (!["1", "2"].includes(acct) || !["buy", "sell"].includes(action)) throw new Error("账号或交易方向不正确");
  const ca = d.ca, A = ["--acct", acct];
  // 按比例买:1pct / half,或自定义 p0.3(= 总量的 0.3%,0.01–1)
  const pctOf = arg === "1pct" ? 1 : arg === "half" ? 0.5 : /^p\d/.test(String(arg)) ? Number(String(arg).slice(1)) : null;
  const isPct = pctOf !== null;
  const bnb = isPct ? null : arg;
  if (isPct && (!Number.isFinite(pctOf) || pctOf < 0.01 || pctOf > 1)) throw new Error("比例必须在 0.01%–1% 之间");
  if (action === "buy" && !isPct && !(Number.isFinite(Number(bnb)) && Number(bnb) > 0)) throw new Error("买入金额必须为正数");
  if (action === "sell" && !(Number.isFinite(Number(arg)) && Number(arg) > 0 && Number(arg) <= 100)) throw new Error("卖出比例必须在 1–100 之间");
  if (action === "sell") {
    const pct = arg;
    if (d.platform === "four") return fourEnv(acct, { script: SHARE + "foursell.mjs", args: [ca, pct, "--slip", "10"] });
    if (d.platform === "idagent") return { script: AGENTBUY + "sell.mjs", args: [ca, pct, ...A] };
    if (d.stage === "outer") return { script: AGENTBUY + "dexsell.mjs", args: [ca, pct, ...A] };
    if (d.platform === "flapportal") return { script: AGENTBUY + "flapportal.mjs", args: ["sell", ca, pct, ...A] };
    if (d.platform === "gangv1") return { script: AGENTBUY + "gang/gangv1sell.mjs", args: [ca, "--pct", pct, ...A, ...(appConfirm ? ["--app-confirm"] : [])] };
    if (d.platform === "gangv2") return { script: AGENTBUY + "gang/gangv2sell.mjs", args: [ca, pct, ...A, ...(appConfirm ? ["--app-confirm"] : [])] };
    if (d.platform === "gangv3") return { script: AGENTBUY + "gang/gangv3.mjs", args: ["sell", ca, pct, ...A, ...(appConfirm ? ["--app-confirm"] : [])] };
    throw new Error("不知道怎么卖这个币");
  }
  // buy
  if (d.stage === "outer" || d.platform === "dex") {
    if (!bnb) throw new Error("外盘买入请填 BNB 数量");
    return { script: AGENTBUY + "dexbuy.mjs", args: [ca, bnb, ...A] };
  }
  if (d.platform === "four") {
    let budget = bnb;
    if (isPct) {
      const c = d.cost1pct ? d.cost1pct * pctOf : null;   // 买 1% 的报价 × 比例
      if (!c) throw new Error("报不出买 1% 的价格,请改填 BNB 数量");
      budget = (Math.ceil(c * 1.05 * 1e5) / 1e5).toFixed(5);   // 多带 5%,超过 1% 的部分脚本会自动卡住,多的退回
    }
    return fourEnv(acct, { script: SHARE + "fourbuy.mjs", args: [ca, budget] });
  }
  // Flap 普通 Portal / 门槛盘:按 BNB 买;按比例买用「买 1%」的估价折成 BNB(多带 5%,超过 2% 额度的部分同一笔退回)
  if (d.platform === "flapportal") {
    let amt = bnb;
    if (isPct) {
      const c = d.cost1pctBnb ? d.cost1pctBnb * pctOf : null;
      if (!c) throw new Error("报不出买 1% 的价格,请改填 BNB 数量");
      amt = (Math.ceil(c * 1.05 * 1e5) / 1e5).toFixed(5);
    }
    return { script: AGENTBUY + "flapportal.mjs", args: ["buy", ca, amt, ...A] };
  }
  if (d.platform === "gangv3") {
    if (!isPct) throw new Error("Gang 内盘请用「买 1% / 买 0.5%」");
    return { script: AGENTBUY + "gang/gangv3.mjs", args: ["buy", ca, ...(pctOf < 1 ? ["--tokens", String(Math.round(pctOf * 1e7))] : []), ...A] };
  }
  if (d.platform === "gangv1" || d.platform === "gangv2") {
    if (!isPct) throw new Error("Gang 内盘请用「买 1% / 买 0.5%」");
    const script = AGENTBUY + (d.platform === "gangv1" ? "gang/gangv1buy.mjs" : "gang/gangbuy.mjs");
    // 1% = 1000 万个(总量 10 亿);买 1% 时不传 --tokens,脚本按剩余额度买满
    return { script, args: [ca, ...(pctOf < 1 ? ["--tokens", String(Math.round(pctOf * 1e7))] : []), ...A] };
  }
  if (d.platform === "idagent") {
    if (!bnb) throw new Error("Flap 内盘请填 BNB 数量");
    return { script: AGENTBUY + "fast.mjs", args: [ca, bnb, ...A, "--wait"] };
  }
  throw new Error("不知道怎么买这个币");
}
function fourEnv(acct, cmd) {
  return { ...cmd, env: { ...process.env, AGENTBUY_ACCT: acct }, fourAcct: acct };
}

export function enforceBnbLimit(d, action, plans, maximum) {
  const cap = Number(maximum);
  if (action !== "buy" || !(cap > 0)) return plans;
  for (const plan of plans) {
    if (d.stage === "inner" && d.platform?.startsWith("gang")) {
      const index = plan.args.indexOf("--max-bnb");
      if (index < 0) plan.args.push("--max-bnb", String(cap));
      else plan.args[index + 1] = String(Math.min(Number(plan.args[index + 1]), cap));
    } else {
      const value = Number(plan.args[d.platform === "flapportal" && d.stage === "inner" ? 2 : 1]);
      if (!(value > 0) || value > cap) throw new Error(`实际发送金额超过 ${cap} BNB 上限或无法估算,不提交`);
    }
  }
  return plans;
}
