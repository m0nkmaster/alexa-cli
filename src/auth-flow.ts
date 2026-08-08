import { createServer } from "node:http";
import type { Domain } from "./config.js";
import { startTunnel } from "./tunnel.js";

const PROXY_PORT = 8080;

const LOCALE_MAP: Record<string, { amazonPageProxyLanguage: string; acceptLanguage: string }> = {
  "amazon.co.uk": { amazonPageProxyLanguage: "en_GB", acceptLanguage: "en-GB" },
  "amazon.com": { amazonPageProxyLanguage: "en_US", acceptLanguage: "en-US" },
  "amazon.de": { amazonPageProxyLanguage: "de_DE", acceptLanguage: "de-DE" },
};

export interface AuthFlowResult {
  refreshToken: string;
  domain: string;
}

export async function runBrowserAuth(domain: Domain = "amazon.co.uk"): Promise<AuthFlowResult> {
  const locale = LOCALE_MAP[domain] ?? LOCALE_MAP["amazon.co.uk"];
  const baseAmazonPage = (domain as string) === "amazon.co.jp" ? "amazon.co.jp" : "amazon.com";

  let tunnel: Awaited<ReturnType<typeof startTunnel>> = null;
  let proxyOwnIp = "127.0.0.1";

  const placeholder = createServer((_, res) => {
    res.writeHead(200);
    res.end("Starting...");
  });
  placeholder.listen(PROXY_PORT, "127.0.0.1", () => {});

  try {
    tunnel = await startTunnel(PROXY_PORT);
    if (tunnel) {
      proxyOwnIp = tunnel.host;
    }
  } finally {
    placeholder.close();
    await new Promise((r) => setTimeout(r, 500));
  }

  const alexaCookie = (await import("alexa-cookie2")).default;
  const opts: Record<string, unknown> = {
    amazonPage: domain,
    baseAmazonPage,
    proxyOnly: true,
    setupProxy: true,
    proxyOwnIp,
    proxyPort: PROXY_PORT,
    proxyListenBind: "127.0.0.1",
    proxyLogLevel: "warn" as const,
    amazonPageProxyLanguage: locale.amazonPageProxyLanguage,
    acceptLanguage: locale.acceptLanguage,
    deviceAppName: "alexa-cli",
    ...(tunnel ? { proxyTunnelUrl: tunnel.url } : {}),
  };

  const url = tunnel ? tunnel.url : `http://127.0.0.1:${PROXY_PORT}`;
  const publicIpRes = await fetch("https://api.ipify.org?format=json");
  const publicIp = publicIpRes.ok ? (await publicIpRes.json()).ip : "unknown";
  console.error(`Visit this URL to log in: ${url}`);
  console.error(`Public IP: ${publicIp}\n`);

  return new Promise((resolve, reject) => {

    alexaCookie.generateAlexaCookie(opts, (err: Error | null, result: { refreshToken?: string }) => {
      if (err && err.message.includes("Please open")) {
        return; // Proxy is ready; keep running, callback will fire again on success
      }
      tunnel?.close();
      alexaCookie.stopProxyServer?.();

      if (err) {
        reject(err);
        return;
      }
      const token = result?.refreshToken;
      if (!token) {
        reject(new Error("No refresh token in result"));
        return;
      }
      resolve({ refreshToken: token, domain });
    });
  });
}
