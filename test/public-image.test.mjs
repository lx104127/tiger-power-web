import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const data = await mkdtemp(join(tmpdir(), "tiger-image-test-"));
process.env.PANEL_DATA_DIR = data; process.env.PANEL_MODE = "web";
const { safeDownload, tokenImage } = await import("../panel/enrich.mjs");
after(() => rm(data, { recursive: true, force: true }));

test("images and their metadata never fetch localhost, private IPv4 or mapped IPv6 URLs", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected network request"); };
  try {
    for (const url of ["http://1.1.1.1/x", "https://127.0.0.1/x", "https://10.0.0.1/x", "https://169.254.169.254/x", "https://[::1]/x", "https://[::ffff:127.0.0.1]/x", "https://[::ffff:a00:1]/x", "https://user:secret@1.1.1.1/x"]) assert.equal(await safeDownload(url), null);
    assert.equal(await tokenImage("0x" + "4".repeat(40), { platform: "idagent", uri: "http://127.0.0.1/private" }), null);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("redirects to private hosts and oversized streamed images are rejected and cancelled", async () => {
  const original = globalThis.fetch; let calls = 0, cancelled = false;
  try {
    globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } }); };
    assert.equal(await safeDownload("https://1.1.1.1/image"), null);
    assert.equal(calls, 1);
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-length": String(4 * 1024 * 1024) } });
    assert.equal(await safeDownload("https://1.1.1.1/large"), null);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = original; }
});
