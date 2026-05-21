/**
 * proxyRelay.ts
 *
 * Runs a lightweight local HTTP-CONNECT proxy relay on the Windows host.
 * Android's global proxy setting works fine when there's no auth required —
 * the relay handles the upstream credentials internally, so Android just sees
 * an unauthenticated local endpoint.
 *
 * Each unique upstream proxy gets its own relay server on a random OS-assigned
 * port. If two devices share the same upstream proxy they reuse the same relay.
 */

import * as net from "net";

export interface RelayUpstream {
  host: string;
  port: number;
  user?: string;
  pass?: string;
}

interface RelayEntry {
  server: net.Server;
  port: number;
}

const relays = new Map<string, RelayEntry>();

function relayKey(u: RelayUpstream): string {
  return `${u.host}|${u.port}|${u.user ?? ""}|${u.pass ?? ""}`;
}

function basicAuth(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

// ── CONNECT tunnel (HTTPS) ────────────────────────────────────────────────────

function handleConnect(
  clientSock: net.Socket,
  target: string,
  upstream: RelayUpstream,
): void {
  const upSock = net.connect(upstream.port, upstream.host);

  upSock.once("connect", () => {
    let req = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
    if (upstream.user) {
      req += `Proxy-Authorization: ${basicAuth(upstream.user, upstream.pass ?? "")}\r\n`;
    }
    req += "\r\n";
    upSock.write(req);

    // Wait for upstream's 200 response before piping
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("binary");
      if (!buf.includes("\r\n\r\n")) return;
      upSock.removeListener("data", onData);
      if (/^HTTP\/1\.[01] 200/.test(buf)) {
        clientSock.write("HTTP/1.1 200 Connection established\r\n\r\n");
        clientSock.pipe(upSock);
        upSock.pipe(clientSock);
      } else {
        try { clientSock.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch { /* */ }
        clientSock.destroy();
        upSock.destroy();
      }
    };
    upSock.on("data", onData);
  });

  upSock.on("error", () => {
    try { clientSock.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch { /* */ }
    clientSock.destroy();
  });
  clientSock.on("error", () => upSock.destroy());
  upSock.on("close",   () => { try { clientSock.destroy(); } catch { /* */ } });
  clientSock.on("close", () => { try { upSock.destroy();   } catch { /* */ } });
}

// ── Plain HTTP forward ────────────────────────────────────────────────────────

function handleHttp(
  clientSock: net.Socket,
  rawRequest: Buffer,
  upstream: RelayUpstream,
): void {
  const upSock = net.connect(upstream.port, upstream.host);

  upSock.once("connect", () => {
    if (upstream.user) {
      // Inject Proxy-Authorization before the blank line
      let s = rawRequest.toString("utf8");
      const end = s.indexOf("\r\n\r\n");
      if (end !== -1) {
        s =
          s.slice(0, end) +
          `\r\nProxy-Authorization: ${basicAuth(upstream.user, upstream.pass ?? "")}` +
          s.slice(end);
      }
      upSock.write(s);
    } else {
      upSock.write(rawRequest);
    }
    clientSock.pipe(upSock);
    upSock.pipe(clientSock);
  });

  upSock.on("error", () => {
    try { clientSock.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch { /* */ }
    clientSock.destroy();
  });
  clientSock.on("error", () => upSock.destroy());
  upSock.on("close",   () => { try { clientSock.destroy(); } catch { /* */ } });
  clientSock.on("close", () => { try { upSock.destroy();   } catch { /* */ } });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the local port of a relay that forwards to `upstream`.
 * Creates one if it doesn't exist yet. Multiple callers with identical
 * upstream configs share the same relay server.
 */
export async function getOrCreateRelay(upstream: RelayUpstream): Promise<number> {
  const key = relayKey(upstream);
  const existing = relays.get(key);
  if (existing) return existing.port;

  const server = net.createServer((clientSock) => {
    clientSock.on("error", () => { /* ignore individual socket errors */ });

    let buf = Buffer.alloc(0);
    let parsed = false;

    const onData = (chunk: Buffer) => {
      if (parsed) return;
      buf = Buffer.concat([buf, chunk]);
      const s = buf.toString("utf8");
      const headerEnd = s.indexOf("\r\n\r\n");
      if (headerEnd === -1) return; // header not complete yet

      parsed = true;
      clientSock.removeListener("data", onData);

      const firstLine = s.split("\r\n")[0] ?? "";
      if (firstLine.startsWith("CONNECT ")) {
        const target = firstLine.split(" ")[1] ?? "";
        handleConnect(clientSock, target, upstream);
      } else {
        handleHttp(clientSock, buf, upstream);
      }
    };

    clientSock.on("data", onData);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "0.0.0.0", () => {
      const addr = server.address() as net.AddressInfo;
      resolve(addr.port);
    });
    server.on("error", reject);
  });

  relays.set(key, { server, port });
  console.log(
    `[proxyRelay] relay started on 0.0.0.0:${port} → ${upstream.host}:${upstream.port}`,
  );
  return port;
}

/** Tears down the relay for a specific upstream (if it exists). */
export async function stopRelay(upstream: RelayUpstream): Promise<void> {
  const key = relayKey(upstream);
  const entry = relays.get(key);
  if (!entry) return;
  await new Promise<void>((r) => entry.server.close(() => r()));
  relays.delete(key);
  console.log(`[proxyRelay] relay stopped (was → ${upstream.host}:${upstream.port})`);
}
