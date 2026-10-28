// The CLI's OS keychain uses one shared service/account name. Web wallet slots
// must use their separate encrypted session files instead of that shared keychain.
import { registerHooks, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
// CLI 1.12 stores its public RWA metadata cache beneath os.homedir(), even
// when BINANCE_BAW_DIR is set. Give this child process its own cache profile;
// HOME stays unchanged and existing encrypted wallet sessions are not moved.
const walletDirectory = process.env.BINANCE_BAW_DIR;
if (!walletDirectory || !isAbsolute(walletDirectory)) throw new Error("Web wallet requires an absolute isolated session directory");
const cacheHome = join(walletDirectory, "cli-home");
mkdirSync(cacheHome, { recursive: true, mode: 0o700 });
os.homedir = () => cacheHome;
syncBuiltinESMExports();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@github/keytar") throw new Error("Web wallet uses isolated file storage");
    return nextResolve(specifier, context);
  },
});
