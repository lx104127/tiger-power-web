import { StringDecoder } from "node:string_decoder";
export function redactOrderOutput(line) {
  return String(line)
    .replace(/((?:"?)(?:clientId|sessionToken|accessToken|refreshToken|apiKey|privateKey|mnemonic)(?:"?)\s*[:=]\s*"?)[^",\s}]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/g, value => {
      try {
        const url = new URL(value);
        if (url.username || url.password || /\/(v1|v2|api)\/[a-z0-9_-]{16,}/i.test(url.pathname) || [...url.searchParams.keys()].some(key => /api.?key|secret|token|client.?id/i.test(key))) return url.origin + "/[redacted]";
      } catch {}
      return value;
    });
}
export function consumeOrderLines(stream, onLine) {
  const decoder = new StringDecoder("utf8"); let buffered = "";
  const drain = final => {
    let end;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end).replace(/\r$/, ""); buffered = buffered.slice(end + 1);
      if (line) onLine(redactOrderOutput(line.slice(0, 8192)));
    }
    if (final || buffered.length > 8192) { if (buffered) onLine(redactOrderOutput(buffered.slice(0, 8192))); buffered = ""; }
  };
  stream.on("data", chunk => { buffered += typeof chunk === "string" ? chunk : decoder.write(chunk); drain(false); });
  stream.on("end", () => { buffered += decoder.end(); drain(true); });
}
