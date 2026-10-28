import { randomUUID } from "node:crypto";
import { redactOrderOutput } from "./order-output.mjs";
const HARD_MAX_TRADE = 0.5;
const lc = value => String(value ?? "").toLowerCase();
export const COPY_DEFAULTS = {
  mode: "fixed",          // fixed = 每次固定 BNB;ratio = 对方买入 BNB × ratioPct%
  amountBnb: 0.01, ratioPct: 10,
  maxPerTrade: 0.05,      // 单笔(每个钱包)上限
  maxPerToken: 0.05,      // 同一个币最多跟买多少(每个钱包)
  dailyCap: 0.2,          // 每天合计(所有钱包)
  maxOpen: 5,             // 最多同时持有几个跟单买的币
  onlyFirst: true,        // 只跟建仓(对方第一次买),同一个币只跟一次
  minTargetBnb: 0, maxTargetBnb: 0, maxMcUsd: 0,   // 0 = 不限
  platforms: ["four", "gang", "flap"],
  maxDelaySec: 15,        // 对方成交后超过几秒才看到就不跟
  slippage: 20,
  wallets: ["1"],
  followSell: false,
  dryRun: true,           // 模拟:只记录会怎么下单,不花钱
  maxCopies: 1,           // 最多跟几次(买入),0 = 不限;跟满自动关闭
};
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
function cleanParams(p = {}, base = COPY_DEFAULTS) {
  const o = { ...base };
  if (p.mode !== undefined) o.mode = p.mode === "ratio" ? "ratio" : "fixed";
  if (p.amountBnb !== undefined) o.amountBnb = clamp(p.amountBnb, 0, HARD_MAX_TRADE, base.amountBnb);
  if (p.ratioPct !== undefined) o.ratioPct = clamp(p.ratioPct, 0, 1000, base.ratioPct);
  if (p.maxPerTrade !== undefined) o.maxPerTrade = clamp(p.maxPerTrade, 0, HARD_MAX_TRADE, base.maxPerTrade);
  if (p.maxPerToken !== undefined) o.maxPerToken = clamp(p.maxPerToken, 0, 10, base.maxPerToken);
  if (p.dailyCap !== undefined) o.dailyCap = clamp(p.dailyCap, 0, 50, base.dailyCap);
  if (p.maxOpen !== undefined) o.maxOpen = Math.round(clamp(p.maxOpen, 1, 100, base.maxOpen));
  if (p.onlyFirst !== undefined) o.onlyFirst = !!p.onlyFirst;
  for (const k of ["minTargetBnb", "maxTargetBnb", "maxMcUsd"]) if (p[k] !== undefined) o[k] = clamp(p[k], 0, 1e12, base[k]);
  if (p.platforms !== undefined) o.platforms = [...new Set([].concat(p.platforms).filter((x) => ["four", "gang", "flap"].includes(x)))];
  if (p.maxDelaySec !== undefined) o.maxDelaySec = Math.round(clamp(p.maxDelaySec, 1, 600, base.maxDelaySec));
  if (p.slippage !== undefined) o.slippage = clamp(p.slippage, 1, 50, base.slippage);
  if (p.wallets !== undefined) o.wallets = [...new Set([].concat(p.wallets).map(String).filter((x) => ["1", "2"].includes(x)))];
  if (p.followSell !== undefined) o.followSell = !!p.followSell;
  if (p.dryRun !== undefined) o.dryRun = !!p.dryRun;
  if (p.maxCopies !== undefined) o.maxCopies = Math.round(clamp(p.maxCopies, 0, 1000, base.maxCopies));
  if (!o.platforms.length) throw new Error("至少选一个平台");
  if (!o.wallets.length) throw new Error("至少选一个钱包");
  return o;
}

// Persist reservations before dispatch. A timeout is an unknown transaction
// outcome, so its budget is retained and the task pauses for reconciliation.
export function createCopyEngine({ initialState = {}, initialLog = [], persist = () => {}, order, detect, price = async () => null, notify = () => {}, emit = () => {}, log = () => {}, now = Date.now } = {}) {
  const clone = value => structuredClone(value);
  let state = { schemaVersion: 2, paused: !!initialState.paused, tasks: clone(initialState.tasks || []) };
  const recent = clone(initialLog).slice(0, 300);
  const chains = new Map();
  for (const task of state.tasks) {
    task.revision ||= 0;
    task.seen ||= [];
    task.paper ||= { tokens: {}, days: {} };
    for (const token of Object.values(task.tokens || {})) {
      if (!token.wallets) token.wallets = Object.fromEntries(task.params.wallets.map(a => [a, { bought: token.bought || 0, open: false, pending: !!token.open }]));
    }
    if (initialState.schemaVersion !== 2 || Object.values(task.tokens || {}).some(t => Object.values(t.wallets || {}).some(p => p.pending))) {
      if (task.status !== "closed") task.status = "paused";
      if (initialState.schemaVersion !== 2) task.params.dryRun = true;
      task.pauseReason = "重启后请核对跟单配置及未确认交易";
    }
  }
  const day = () => new Date(now() + 8 * 3600_000).toISOString().slice(0, 10);
  const get = id => state.tasks.find(t => t.id === id);
  function commit(change) {
    const draft = clone(state);
    const result = change(draft);
    persist(draft); // A failed write must prevent the financial operation.
    state = draft;
    emit({ type: "copy-tasks" });
    return clone(result);
  }
  function record(task, kind, reason, ev = {}, extra = {}) {
    const entry = { ts: Math.floor(now() / 1000), task: task.id, taskName: task.name, target: task.target, kind, reason, token: ev.ca || null, symbol: ev.symbol || null, action: ev.action || null, ...extra };
    recent.unshift(entry); if (recent.length > 300) recent.length = 300;
    log(entry); emit({ type: "copy-log", ...entry });
    return entry;
  }
  function limit(task) {
    const count = task.params.dryRun ? task.stats.simCopies : task.stats.copies;
    const book = task.params.dryRun ? task.paper : task;
    if (task.params.maxCopies > 0 && count >= task.params.maxCopies && task.status !== "closed") {
      task.buyLimitReached = true;
      if (task.params.followSell && Object.values(book.tokens).some(token => token.open)) return;
      task.status = "closed"; task.closedAt = now(); task.closeReason = `已跟满 ${task.params.maxCopies} 次`;
    }
  }
  function syncToken(token) {
    const positions = Object.values(token.wallets);
    token.open = positions.some(p => p.open || p.pending);
    token.bought = Math.max(0, ...positions.map(p => p.bought));
  }
  const view = () => ({ ...clone(state), log: clone(recent), defaults: clone(COPY_DEFAULTS) });
  function task(body) {
    return commit(draft => {
      if (!body.id) {
        if (!/^0x[0-9a-f]{40}$/.test(lc(body.target))) throw new Error("目标地址格式不对");
        const item = { id: "c" + randomUUID().replaceAll("-", ""), target: lc(body.target), name: String(body.name || "").slice(0, 40) || lc(body.target).slice(0, 8), createdAt: now(), revision: 0,
          status: "paused", params: { ...cleanParams(body.params), dryRun: true }, stats: { buyBnb: 0, buys: 0, sells: 0, sims: 0, copies: 0, simCopies: 0, lastAt: null }, tokens: {}, days: {}, paper: { tokens: {}, days: {} }, seen: [] };
        draft.tasks.push(item); return item;
      }
      const item = draft.tasks.find(t => t.id === body.id);
      if (!item) throw new Error("没有这个跟单任务");
      if (body.delete) {
        if (item.status !== "closed") throw new Error("先关闭任务再删除");
        if (Object.values(item.tokens).some(t => Object.values(t.wallets || {}).some(p => p.pending))) throw new Error("任务仍有结果待核对的交易,保留记录");
        draft.tasks = draft.tasks.filter(t => t !== item); return { ok: true };
      }
      if (item.status === "closed" && (body.params || (body.status && body.status !== "closed"))) throw new Error("已关闭的任务不能再启动,请新建");
      const params = body.params ? cleanParams(body.params, item.params) : item.params;
      const status = body.status || item.status;
      if (!["running", "paused", "closed"].includes(status)) throw new Error("状态不对");
      if (status === "running" && !params.dryRun && (body.params || body.status === "running") && body.confirmLive !== true) throw new Error("启动或修改真实跟单前必须明确确认钱包和限额");
      if (status === "running" && !params.dryRun && Object.values(item.tokens).some(t => Object.values(t.wallets || {}).some(p => p.pending))) throw new Error("先核对上次未确认的交易,不能自动重试");
      item.params = params; item.status = status;
      if (body.name !== undefined) item.name = String(body.name).slice(0, 40) || item.name;
      if (status === "closed") { item.closedAt = now(); item.closeReason = "手动关闭"; }
      item.revision++;
      return item;
    });
  }
  function pauseAll(paused, confirmLive = false) {
    if (typeof paused !== "boolean") throw new Error("暂停状态必须为布尔值");
    if (!paused && state.tasks.some(t => t.status === "running" && !t.params.dryRun) && !confirmLive) throw new Error("恢复真实跟单前必须确认");
    commit(draft => { draft.paused = paused; }); return view();
  }
  async function decide(id, incoming) {
    let t = get(id);
    const ev = { ...incoming, ca: lc(incoming.ca) };
    if (!t || t.status !== "running") return;
    if (state.paused) return record(t, "skip", "全部暂停中", ev);
    if (!/^0x[0-9a-f]{40}$/.test(ev.ca) || !["buy", "sell"].includes(ev.side)) return;
    const p = clone(t.params), revision = t.revision;
    const timestamp = Number(ev.ts), expiresAt = timestamp * 1000 + p.maxDelaySec * 1000;
    if (!(timestamp > 0) || timestamp * 1000 > now() + 5000 || now() > expiresAt) return record(t, "skip", "事件时间不明或已超过跟单时限", ev);
    const key = String(ev.id || `${ev.txHash || ev.tx || ev.hash || timestamp}:${ev.logIndex ?? ev.index ?? ""}:${ev.ca}:${ev.side}:${ev.quoteAmt ?? ""}`);
    if (t.seen.includes(key)) return record(t, "skip", "重复事件", ev);
    const proceed = () => { const current = get(id); return current?.status === "running" && current.revision === revision && !state.paused && now() <= expiresAt; };
    let ledger = p.dryRun ? t.paper : t;
    let token = ledger.tokens[ev.ca];
    let wallets = p.wallets;
    let amount, pct;
    if (ev.side === "sell") {
      if (!p.followSell) return;
      wallets = wallets.filter(a => token?.wallets?.[a]?.open && !token.wallets[a].pending);
      if (!wallets.length) return record(t, "skip", "所选钱包没有已确认的跟买持仓", ev);
      const fraction = Number(ev.pct);
      if (ev.action !== "清仓" && !(Number.isFinite(fraction) && fraction > 0)) return record(t, "skip", "目标卖出比例不明,不自动清仓", ev);
      pct = ev.action === "清仓" ? 100 : Math.min(100, Math.max(1, Math.round(fraction)));
    } else {
      const platform = { four: "four", gangv1: "gang", gangv2: "gang", gangv3: "gang", idagent: "flap", flapportal: "flap" }[ev.platform];
      if (!p.platforms.includes(platform)) return record(t, "skip", "平台没有勾选", ev);
      if (p.maxCopies > 0 && (p.dryRun ? t.stats.simCopies : t.stats.copies) >= p.maxCopies) return record(t, "skip", "跟单次数已用完", ev);
      if (p.onlyFirst && (ev.action === "加仓" || token?.n > 0)) return record(t, "skip", "只跟首次建仓", ev);
      if (wallets.some(a => Object.values(ledger.tokens).some(position => position.wallets?.[a]?.pending))) return record(t, "skip", "上次交易结果待核对", ev);
      let targetBnb = ["BNB", "WBNB"].includes(ev.quote) ? Number(ev.quoteAmt) : null;
      if (targetBnb === null && Number(ev.usd) > 0) { const px = await price().catch(() => null); if (px > 0) targetBnb = Number(ev.usd) / px; }
      if (!(targetBnb > 0) || !Number.isFinite(targetBnb)) targetBnb = null;
      if (p.minTargetBnb > 0 && !(targetBnb >= p.minTargetBnb)) return record(t, "skip", "目标买入金额不满足下限或无法估算", ev);
      if (p.maxTargetBnb > 0 && !(targetBnb !== null && targetBnb <= p.maxTargetBnb)) return record(t, "skip", "目标买入金额超过上限或无法估算", ev);
      if (p.maxMcUsd > 0) {
        const info = await detect?.(ev.ca).catch(() => null);
        if (!(info?.mcUsd > 0) || info.mcUsd > p.maxMcUsd) return record(t, "skip", "市值不满足限额或无法估算", ev);
      }
      if (!proceed()) return record(t, "skip", "任务已暂停、配置改变或超过时限", ev);
      t = get(id); ledger = p.dryRun ? t.paper : t; token = ledger.tokens[ev.ca];
      const base = p.mode === "ratio" ? (targetBnb || 0) * p.ratioPct / 100 : p.amountBnb;
      const perToken = Math.min(...wallets.map(a => p.maxPerToken - (token?.wallets?.[a]?.bought || 0)));
      const remaining = (p.dailyCap - (ledger.days[day()] || 0)) / wallets.length;
      amount = Math.floor(Math.min(base, p.maxPerTrade, HARD_MAX_TRADE, perToken, remaining) * 1e5 + 1e-8) / 1e5;
      if (!(amount >= 0.001)) return record(t, "skip", "单笔、单币或每日额度不足", ev);
      if (!token?.open && Object.values(ledger.tokens).filter(x => x.open).length >= p.maxOpen) return record(t, "skip", "同时持仓数达到上限", ev);
    }
    if (!proceed()) return record(t, "skip", "任务已暂停、配置改变或超过时限", ev);
    const date = day();
    commit(draft => {
      const current = draft.tasks.find(x => x.id === id), book = p.dryRun ? current.paper : current;
      const position = book.tokens[ev.ca] ||= { symbol: ev.symbol, n: 0, wallets: {}, open: false, bought: 0 };
      current.seen.push(key); current.seen = current.seen.slice(-1000);
      for (const acct of wallets) {
        const wallet = position.wallets[acct] ||= { bought: 0, open: false, pending: false };
        if (ev.side === "buy") { wallet.bought += amount; wallet.pending = !p.dryRun; if (p.dryRun) wallet.open = true; }
        else if (p.dryRun && pct === 100) wallet.open = false;
        else if (!p.dryRun) wallet.pending = true;
      }
      if (ev.side === "buy") {
        position.n++;
        book.days[date] = (book.days[date] || 0) + amount * wallets.length;
        if (p.dryRun) current.stats.simCopies++;
        else { current.stats.copies++; current.stats.buys++; current.stats.buyBnb += amount * wallets.length; }
      }
      if (p.dryRun) current.stats.sims++;
      current.stats.lastAt = now(); syncToken(position);
      if (p.dryRun) limit(current);
    });
    if (p.dryRun) return record(get(id), "sim", ev.side === "buy" ? `会用 ${amount} BNB × ${wallets.length} 个钱包买入` : `会卖出 ${pct}%`, ev, { bnb: amount, pct });
    let response, failure;
    try {
      if (!order) throw new Error("跟单执行器未初始化");
      response = await order({ ca: ev.ca, action: ev.side, accts: wallets, bnb: amount, arg: pct ? String(pct) : undefined, slip: p.slippage, expiresAt, shouldProceed: proceed });
    } catch (error) { failure = error; }
    const notStarted = failure?.code === "ORDER_NOT_STARTED";
    const completed = wallets.every(a => response?.results?.[a]?.ok === true);
    commit(draft => {
      const current = draft.tasks.find(x => x.id === id), position = current.tokens[ev.ca];
      for (const acct of wallets) {
        const wallet = position.wallets[acct];
        if (notStarted) {
          wallet.pending = false;
          if (ev.side === "buy") wallet.bought = Math.max(0, wallet.bought - amount);
        } else if (response?.results?.[acct]?.ok === true) {
          wallet.pending = false; wallet.open = ev.side === "buy" || pct !== 100;
        } // Unknown outcomes retain the reservation and block automatic retries.
      }
      if (notStarted && ev.side === "buy") {
        current.days[date] = Math.max(0, current.days[date] - amount * wallets.length);
        current.stats.buyBnb = Math.max(0, current.stats.buyBnb - amount * wallets.length);
        current.stats.copies--; current.stats.buys--; position.n--;
      }
      if (ev.side === "sell" && completed) current.stats.sells++;
      if (!notStarted && !completed && current.status !== "closed") { current.status = "paused"; current.pauseReason = "交易结果待核对,不会自动重试"; }
      syncToken(position); if (completed) limit(current);
    });
    const results = response?.results ? Object.fromEntries(wallets.map(acct => {
      const result = response.results[acct] || {};
      return [acct, { ok: result.ok === true, submitted: result.submitted === true, txHash: /^0x[0-9a-f]{64}$/i.test(result.txHash || "") ? result.txHash : null, last: (result.last || []).slice(-2).map(line => redactOrderOutput(line).slice(0, 300)) }];
    })) : undefined;
    const result = record(get(id), completed ? "order" : notStarted ? "skip" : "review", completed ? (ev.side === "buy" ? `买入 ${amount} BNB × ${wallets.length} 个钱包` : `卖出 ${pct}%`) : notStarted ? "没有开始下单" : "交易结果待核对,已保留预算并暂停任务", ev, { bnb: amount, pct, results });
    notify(`跟单「${get(id).name}」${result.reason}\n${ev.ca}`);
    return result;
  }
  function processEvent(ev) {
    if (ev.type !== "track" || ev.backfill || !ev.ca) return Promise.resolve([]);
    const work = state.tasks.filter(t => t.target === lc(ev.target) && t.status === "running").map(t => {
      const previous = chains.get(t.id) || Promise.resolve();
      const next = previous.then(() => decide(t.id, ev)).catch(error => {
        try { commit(draft => { const item = draft.tasks.find(x => x.id === t.id); if (item && item.status !== "closed") item.status = "paused"; }); }
        catch { const item = get(t.id); if (item && item.status !== "closed") item.status = "paused"; }
        try { const item = get(t.id); if (item) record(item, "error", error.message, ev); } catch {}
      });
      const cleanup = () => { if (chains.get(t.id) === next) chains.delete(t.id); };
      chains.set(t.id, next); next.then(cleanup, cleanup);
      return next;
    });
    return Promise.all(work);
  }
  return { state: view, task, pauseAll, processEvent };
}
