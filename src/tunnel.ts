import { spawn } from "node:child_process";

const PROXY_PORT = 8080;

export interface TunnelResult {
  url: string;
  host: string;
  close: () => void;
}

export async function startTunnel(port: number = PROXY_PORT): Promise<TunnelResult | null> {
  const cloudflared = await tryCloudflared(port);
  if (cloudflared) return cloudflared;

  const lt = await tryLocaltunnel(port);
  if (lt) return lt;

  return null;
}

async function tryCloudflared(port: number): Promise<TunnelResult | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const proc = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const check = (data: string) => {
      const m = data.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/);
      if (m && !resolved) {
        resolved = true;
        resolve({ url: m[0], host: m[1], close: () => proc.kill("SIGTERM") });
      }
    };

    let buf = "";
    proc.stdout?.on("data", (chunk) => {
      buf += chunk.toString();
      check(buf);
    });
    proc.stderr?.on("data", (chunk) => {
      buf += chunk.toString();
      check(buf);
    });
    proc.on("error", () => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });
    proc.on("exit", (code) => {
      if (!resolved && code !== 0 && code !== null) {
        resolved = true;
        resolve(null);
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill("SIGTERM");
        resolve(null);
      }
    }, 12000);
  });
}

async function tryLocaltunnel(port: number): Promise<TunnelResult | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const proc = spawn("npx", ["-y", "localtunnel", "--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const check = (data: string) => {
      const m = data.match(/https:\/\/([a-z0-9-]+\.(?:loca\.lt|localtunnel\.me))/);
      if (m && !resolved) {
        resolved = true;
        const url = m[0].trim();
        const host = m[1];
        resolve({ url, host, close: () => proc.kill("SIGTERM") });
      }
    };

    let buf = "";
    proc.stdout?.on("data", (chunk) => {
      buf += chunk.toString();
      check(buf);
    });
    proc.stderr?.on("data", (chunk) => {
      buf += chunk.toString();
      check(buf);
    });
    proc.on("error", () => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });
    proc.on("exit", (code) => {
      if (!resolved && code !== 0 && code !== null) {
        resolved = true;
        resolve(null);
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill("SIGTERM");
        resolve(null);
      }
    }, 15000);
  });
}
