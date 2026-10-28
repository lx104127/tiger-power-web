// Test-only CLI double. Never signs or broadcasts anything.
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
const dir = process.env.BINANCE_BAW_DIR;
if (!dir || !process.env.TIGER_TEST) throw new Error("Wallet fixture is test-only");
const acct = basename(dir), file = join(dir, "fixture-session.json");
const connected = existsSync(file);
const [group, action] = process.argv.slice(2);
const data = (value) => console.log(JSON.stringify({ success: true, data: value }));
const address = `0x${acct === "2" ? "2" : "1"}`.padEnd(42, acct === "2" ? "2" : "1");
if (group === "wallet" && action === "status") data({ status: connected ? "CONNECTED" : "UNCONNECTED" });
else if (group === "wallet" && action === "address") data({ addresses: [{ binanceChainId: "56", address }] });
else if (group === "wallet" && action === "settings") data({ maxSigninDuration: "48h", sessionExpireTime: new Date(Date.now() + 48 * 3600_000).toISOString(), devMode: { enabled: false }, dailyLimit: 0 });
else if (group === "wallet" && action === "tx-history") data({ transactions: [], hasMore: false });
else if (group === "auth" && action === "signin") data({ qrCodeId: `fixture-${acct}`, urlForWeb: `https://www.binance.com/en/agent-login?fixture=${acct}`, pairingCode: `TEST0${acct}`, expireAt: Date.now() + 300_000 });
else if (group === "auth" && action === "verify") { await new Promise(r => setTimeout(r, 400)); writeFileSync(file, JSON.stringify({ address }), { mode: 0o600 }); data({ status: "SUCCESS" }); }
else if (group === "auth" && action === "signout") { if (connected) unlinkSync(file); data({ status: "LOGGED_OUT" }); }
else { console.log(JSON.stringify({ success: false, error: { message: "Test fixture refuses transaction commands" } })); process.exitCode = 1; }
