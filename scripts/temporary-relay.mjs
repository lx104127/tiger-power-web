import { createProxyAgent } from "../proxy.mjs";
import http from "node:http";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

// The open-source Tunnelmole protocol transports complete HTTP responses. Keep
// the upstream destination fixed to this app; never log request bodies, cookies,
// login URLs or CSRF query strings. This is a temporary relay, not durable hosting.
export function temporaryRelay({ port, onReady, onFailure }) {
  const clientId = randomUUID();
  const localAgent = new http.Agent({ keepAlive: true });
  let socket, stopped = false, retry, reconnects = 0, readyUrl;
  const requests = new Set();
  const respond = (ws, message) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
  function forward(ws, message) {
    if (typeof message.url !== "string" || !message.url.startsWith("/") || !["GET", "POST", "HEAD"].includes(message.method)) return;
    if (requests.size >= 100) return respond(ws, { type: "forwardedResponse", requestId: message.requestId, statusCode: 503, url: message.url, headers: { "content-type": "text/plain" }, body: Buffer.from("Temporarily busy").toString("base64") });
    let request;
    const failure = () => respond(ws, { type: "forwardedResponse", requestId: message.requestId, statusCode: 502, url: message.url, headers: { "content-type": "text/plain" }, body: Buffer.from("The temporary application is restarting. Please retry.").toString("base64") });
    try {
      request = http.request({ hostname: "127.0.0.1", port, path: message.url, method: message.method, headers: message.headers, agent: localAgent }, response => {
        const chunks = []; let length = 0;
        response.on("data", chunk => { length += chunk.length; if (length > 16 * 1024 * 1024) response.destroy(); else chunks.push(chunk); });
        response.on("error", failure);
        response.on("end", () => respond(ws, { type: "forwardedResponse", requestId: message.requestId, statusCode: response.statusCode, url: message.url, headers: response.headers, body: Buffer.concat(chunks).toString("base64") }));
      });
      requests.add(request);
      request.on("close", () => requests.delete(request));
      request.on("error", failure);
      request.setTimeout(5 * 60_000, () => request.destroy());
      if (message.body) {
        if (message.body.length > 2 * 1024 * 1024) return request.destroy();
        request.write(Buffer.from(message.body, "base64"));
      }
      request.end();
    } catch { request?.destroy(); failure(); }
  }
  function connect() {
    if (stopped) return;
    const ws = socket = new WebSocket("wss://service.tunnelmole.com:8083", { agent: createProxyAgent(), handshakeTimeout: 15000, maxPayload: 20 * 1024 * 1024 });
    ws.on("open", () => ws.send(JSON.stringify({ type: "initialise", clientId, connectionInfo: { isCli: false, isNpm: false, nodeVersion: process.version, tunnelmoleVersion: "2.4.0" } })));
    ws.on("message", data => {
      let message; try { message = JSON.parse(data); } catch { return; }
      if (message.type === "hostnameAssigned") {
        if (!/^[a-z0-9-]+\.tunnelmole\.net$/.test(message.hostname || "")) return ws.close();
        const url = `https://${message.hostname}`;
        reconnects = 0;
        if (url !== readyUrl) { readyUrl = url; Promise.resolve(onReady(url)).catch(onFailure); }
      } else if (message.type === "forwardedRequest") forward(ws, message);
      else if (message.type === "clientDisconnect") { onFailure(new Error("Temporary relay disconnected")); ws.close(); }
    });
    ws.on("error", error => onFailure(new Error(`Temporary relay connection failed: ${error.code || error.name}`)));
    ws.on("close", () => { if (!stopped) retry = setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(reconnects++, 5))); });
  }
  const heartbeat = setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.ping(); }, 25000);
  connect();
  return { close() { stopped = true; clearTimeout(retry); clearInterval(heartbeat); for (const request of requests) request.destroy(); localAgent.destroy(); socket?.terminate(); } };
}
