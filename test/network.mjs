// Test-only ticker response; the application's wallet and HTTP paths stay real.
if (process.env.TIGER_TEST === "1") {
  const original = globalThis.fetch;
  globalThis.fetch = (url, options) => String(url).startsWith("https://api.binance.com/api/v3/ticker/price")
    ? Promise.resolve(Response.json({ price: "600" })) : original(url, options);
}
