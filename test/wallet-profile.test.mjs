import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("headless CLI caches stay in each wallet profile without changing HOME or the parent process", async t => {
  const root = await mkdtemp(join(tmpdir(), "tiger-wallet-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalHome = homedir();
  const loader = fileURLToPath(new URL("../panel/file-wallet-loader.mjs", import.meta.url));
  const profiles = [];
  for (const acct of ["1", "2"]) {
    const directory = join(root, acct);
    const script = `
      import { homedir } from 'node:os';
      import { mkdir, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      const cache = join(homedir(), '.baw');
      await mkdir(cache, { recursive: true });
      await writeFile(join(cache, 'rwa-tokens.json'), JSON.stringify({ fixture: true }));
      if (process.env.HOME !== ${JSON.stringify(process.env.HOME)}) throw new Error('HOME changed');
      let blocked = false; try { await import('@github/keytar'); } catch { blocked = true; }
      if (!blocked) throw new Error('Shared keychain must remain unavailable');
      console.log(cache);
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", loader, "--input-type=module", "-e", script], { env: { ...process.env, BINANCE_BAW_DIR: directory } });
    const profile = stdout.trim(); profiles.push(profile);
    assert.equal(profile, join(directory, "cli-home", ".baw"));
    assert.deepEqual(JSON.parse(await readFile(join(profile, "rwa-tokens.json"), "utf8")), { fixture: true });
  }
  assert.notEqual(...profiles);
  assert.equal(homedir(), originalHome);
});
