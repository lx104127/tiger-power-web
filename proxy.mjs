// Fetch honors Node's environment proxy switch, but the CLI's RPC and ws
// transports also use node:http(s). Share the configured proxy and NO_PROXY
// routing without changing TLS verification or exposing proxy credentials.
import { ProxyAgent } from "proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import { FetchRequest } from "ethers";
export const createProxyAgent = () => new ProxyAgent({
  getProxyForUrl: url => getProxyForUrl(url.replace(/^wss:/, "https:").replace(/^ws:/, "http:")),
});
if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
  FetchRequest.registerGetUrl(FetchRequest.createGetUrlFunc({ agent: createProxyAgent() }));
}
