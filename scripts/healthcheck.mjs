#!/usr/bin/env node
import http from "node:http";
const url = new URL(process.env.PANEL_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "");
const port = Number(process.env.PORT || process.env.PANEL_PORT || 10000);
const request = http.get({ hostname: "127.0.0.1", port, path: "/health", headers: { host: url.host }, agent: new http.Agent() }, response => {
  response.resume();
  process.exitCode = response.statusCode === 200 ? 0 : 1;
});
request.setTimeout(3000, () => request.destroy(new Error("Health check timed out")));
request.on("error", () => { process.exitCode = 1; });
