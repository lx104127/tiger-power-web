// Follow orders remain paused and simulated until the owner explicitly enables
// a real task. State, reservations and logs stay on the private persistent disk.
import { readFileSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
import { statePath } from "../runtime.mjs";
import { bus } from "./live.mjs";
import { bnbUsd } from "./prices.mjs";
import { createCopyEngine, COPY_DEFAULTS } from "./copy-engine.mjs";
import { writePrivateJson } from "./private-json.mjs";
export { COPY_DEFAULTS };
const FILE = statePath("panel/copy-tasks.json"), LOG = statePath("panel/copy-log.jsonl");
let loadError = null, initialState = {}, initialLog = [];
if (existsSync(FILE)) {
  try {
    initialState = JSON.parse(readFileSync(FILE, "utf8"));
    if (!Array.isArray(initialState.tasks)) throw new Error("Invalid copy task state");
  } catch { loadError = "跟单配置无法读取,已停止跟单,请先修复持久磁盘上的配置文件"; initialState = { paused: true, tasks: [] }; }
}
try {
  const lines = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).slice(-5000);
  initialLog = lines.slice(-300).map(line => JSON.parse(line)).reverse();
  if (lines.length === 5000) writeFileSync(LOG, lines.join("\n") + "\n", { mode: 0o600 });
} catch {}
let deps = { order: null, detect: null, notify: () => {} };
const engine = createCopyEngine({ initialState, initialLog,
  persist: state => { if (loadError) throw new Error(loadError); writePrivateJson(FILE, state); },
  order: plan => {
    if (!deps.order) { const error = new Error("跟单执行器未初始化"); error.code = "ORDER_NOT_STARTED"; throw error; }
    return deps.order(plan);
  },
  detect: ca => deps.detect ? deps.detect(ca) : Promise.resolve(null),
  price: bnbUsd, notify: text => deps.notify(text), emit: event => bus.emit("event", event),
  log: entry => { try { appendFileSync(LOG, JSON.stringify(entry) + "\n", { mode: 0o600 }); } catch {} },
});
export function initCopy(config) { deps = { ...deps, ...config }; }
export function copyState() { return { ...engine.state(), error: loadError }; }
export function copyTask(body) { return engine.task(body); }
export function copyPauseAll(paused, confirmLive = false) { return engine.pauseAll(paused, confirmLive); }
bus.on("event", event => { void engine.processEvent(event); });
