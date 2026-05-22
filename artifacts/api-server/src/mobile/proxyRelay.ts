/**
 * proxyRelay.ts
 *
 * Runs a lightweight local HTTP-CONNECT proxy relay on the Windows host.
 * Android's global proxy setting works fine when there's no auth required —
 * the relay handles the upstream credentials internally, so Android just sees
 * an unauthenticated local endpoint.
 *
 * Supports HTTP and SOCKS5 upstream proxies.
 * Each unique upstream gets its own relay server on a random OS-assigned port.
 */

import * as net from "net";

export interface RelayUpstream {
  host?: string;        // upstream proxy host; omit for direct-connect mode
  port?: number;        // upstream proxy port; omit for direct-connect mode
  user?: string;
  pass?: string;
  protocol?: "http" | "socks5";
  localAddress?: string; // bind outgoing sockets to this host adapter IP
}

interface RelayEntry {
  server: net.Server;
  port: number;
}

const relays = new Map<string, RelayEntry>();

function relayKey(u: RelayUpstream): string {
  if (!u.host) return `direct|${u.localAddress ?? ""}`;
  return `${u.protocol ?? "http"}|${u.host}|${u.port}|${u.user ?? ""}|${u.pass ?? ""}|${u.localAddress ?? ""}`;
}

function basicAuth(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

// ── Direct-connect mode (no upstream proxy, bind to localAddress) ──────────────

function handleConnectDirect(
  clientSock: net.Socket,
  target: string,
  localAddress?: string,
): void {
  const [host, portStr] = target.split(":");
  const port = parseInt(portStr ?? "443", 10);
  if (!host || isNaN(port)) {
    try { clientSock.write("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch { /**/ }
    clientSock.destroy(); return;
  }
  const opts: net.NetConnectOpts = { host, port, ...(localAddress ? { localAddress } : {}) };
  const upSock = net.connect(opts);
  upSock.once("connect", () => {
    clientSock.write("HTTP/1.1 200 Connection established\r\n\r\n");
    clientSock.pipe(upSock); upSock.pipe(clientSock);
  });
  upSock.on("error", () => { try { clientSock.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch { /**/ } clientSock.destroy(); });
  clientSock.on("error", () => upSock.destroy());
  upSock.on("close",     () => { try { clientSock.destroy(); } catch { /**/ } });
  clientSock.on("close", () => { try { upSock.destroy(); } catch { /**/ } });
}

// ── HTTP upstream: CONNECT tunnel (HTTPS) ─────────────────────────────────────

function handleConnectViaHttp(
  clientSock: net.Socket,
  target: string,
  upstream: RelayUpstream,
): void {
  const opts: net.NetConnectOpts = { host: upstream.host!, port: upstream.port!, ...(upstream.localAddress ? { localAddress: upstream.localAddress } : {}) };
  const upSock = net.connect(opts);
  upSock.once("connect", () => {
    let req = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
    if (upstream.user) {
      req += `Proxy-Authorization: ${basicAuth(upstream.user, upstream.pass ?? "")}\r\n`;
    }
    req += "\r\n";
    upSock.write(req);
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
        clientSock.destroy(); upSock.destroy();
      }
    };
    upSock.on("data", onData);
  });
  upSock.on("error", () => { try { clientSock.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch { /* */ } clientSock.destroy(); });
  clientSock.on("error", () => upSock.destroy());
  upSock.on("close",    () => { try { clientSock.destroy(); } catch { /* */ } });
  clientSock.on("close", () => { try { upSock.destroy();   } catch { /* */ } });
}

// ── HTTP upstream: plain HTTP forward ─────────────────────────────────────────

function handleHttpViaHttp(
  clientSock: net.Socket,
  rawRequest: Buffer,
  upstream: RelayUpstream,
): void {
  const opts: net.NetConnectOpts = { host: upstream.host!, port: upstream.port!, ...(upstream.localAddress ? { localAddress: upstream.localAddress } : {}) };
  const upSock = net.connect(opts);
  upSock.once("connect", () => {
    if (upstream.user) {
      let s = rawRequest.toString("utf8");
      const end = s.indexOf("\r\n\r\n");
      if (end !== -1) {
        s = s.slice(0, end) +
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
  upSock.on("error", () => { try { clientSock.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch { /* */ } clientSock.destroy(); });
  clientSock.on("error", () => upSock.destroy());
  upSock.on("close",    () => { try { clientSock.destroy(); } catch { /* */ } });
  clientSock.on("close", () => { try { upSock.destroy();   } catch { /* */ } });
}

// ── SOCKS5 upstream: open tunnel to target ────────────────────────────────────

function openSocks5Tunnel(
  upstream: RelayUpstream,
  targetHost: string,
  targetPort: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const opts: net.NetConnectOpts = { host: upstream.host!, port: upstream.port!, ...(upstream.localAddress ? { localAddress: upstream.localAddress } : {}) };
    const sock = net.connect(opts);
    sock.setTimeout(15000, () => { reject(new Error("SOCKS5 connect timeout")); sock.destroy(); });
    sock.on("error", reject);

    const hasAuth = !!(upstream.user && upstream.pass);
    sock.once("connect", () => {
      sock.write(hasAuth
        ? Buffer.from([0x05, 0x02, 0x00, 0x02])  // no-auth + user/pass methods
        : Buffer.from([0x05, 0x01, 0x00]));       // no-auth only

      type Step = "greeting" | "auth" | "connect";
      let step: Step = "greeting";
      let acc = Buffer.alloc(0);

      const onData = (chunk: Buffer) => {
        acc = Buffer.concat([acc, chunk]);

        if (step === "greeting") {
          if (acc.length < 2) return;
          const method = acc[1]!;
          acc = acc.slice(2);
          if (method === 0x02 && hasAuth) {
            step = "auth";
            const u = Buffer.from(upstream.user!);
            const p = Buffer.from(upstream.pass!);
            sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          } else if (method === 0x00) {
            step = "connect";
            sendConnectReq();
          } else {
            sock.removeListener("data", onData);
            reject(new Error("SOCKS5: no acceptable auth method")); sock.destroy();
          }
        } else if (step === "auth") {
          if (acc.length < 2) return;
          const ok = acc[1] === 0x00;
          acc = acc.slice(2);
          step = "connect";
          if (!ok) { sock.removeListener("data", onData); reject(new Error("SOCKS5 auth failed")); sock.destroy(); return; }
          sendConnectReq();
        } else if (step === "connect") {
          if (acc.length < 10) return;
          sock.removeListener("data", onData);
          const rep = acc[1]!;
          if (rep !== 0x00) { reject(new Error(`SOCKS5 connect refused: ${rep}`)); sock.destroy(); return; }
          resolve(sock);
        }
      };

      function sendConnectReq() {
        const h = Buffer.from(targetHost);
        sock.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]),
          h,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
        ]));
      }

      sock.on("data", onData);
    });
  });
}

function handleConnectViaSocks5(
  clientSock: net.Socket,
  target: string,
  upstream: RelayUpstream,
): void {
  const colonIdx = target.lastIndexOf(":");
  const targetHost = colonIdx === -1 ? target : target.slice(0, colonIdx);
  const targetPort = colonIdx === -1 ? 443 : parseInt(target.slice(colonIdx + 1), 10);

  openSocks5Tunnel(upstream, targetHost, targetPort).then((upSock) => {
    clientSock.write("HTTP/1.1 200 Connection established\r\n\r\n");
    clientSock.pipe(upSock);
    upSock.pipe(clientSock);
    const cleanup = () => { try { clientSock.destroy(); } catch { /* */ } try { upSock.destroy(); } catch { /* */ } };
    clientSock.on("error", cleanup); upSock.on("error", cleanup);
    clientSock.on("close", cleanup); upSock.on("close", cleanup);
  }).catch(() => {
    try { clientSock.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch { /* */ }
    clientSock.destroy();
  });
}

function handleHttpViaSocks5(
  clientSock: net.Socket,
  rawRequest: Buffer,
  upstream: RelayUpstream,
): void {
  const headerStr = rawRequest.toString("utf8").split("\r\n\r\n")[0] ?? "";
  const firstLine = headerStr.split("\r\n")[0] ?? "";
  const urlMatch = firstLine.match(/^[A-Z]+ https?:\/\/([^/:]+)(?::(\d+))?/);
  const targetHost = urlMatch?.[1] ?? "localhost";
  const targetPort = parseInt(urlMatch?.[2] ?? "80", 10);

  // Rewrite absolute URL to relative before forwarding to target
  const rewritten = (() => {
    const m = firstLine.match(/^([A-Z]+) https?:\/\/[^/]+(\/[^ ]*)? HTTP\/([\d.]+)/);
    if (!m) return rawRequest;
    const newFirst = `${m[1]} ${m[2] ?? "/"} HTTP/${m[3]}`;
    const old = Buffer.from(firstLine);
    const idx = rawRequest.indexOf(old);
    if (idx === -1) return rawRequest;
    return Buffer.concat([rawRequest.slice(0, idx), Buffer.from(newFirst), rawRequest.slice(idx + old.length)]);
  })();

  openSocks5Tunnel(upstream, targetHost, targetPort).then((upSock) => {
    upSock.write(rewritten);
    clientSock.pipe(upSock);
    upSock.pipe(clientSock);
    const cleanup = () => { try { clientSock.destroy(); } catch { /* */ } try { upSock.destroy(); } catch { /* */ } };
    clientSock.on("error", cleanup); upSock.on("error", cleanup);
    clientSock.on("close", cleanup); upSock.on("close", cleanup);
  }).catch(() => {
    try { clientSock.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch { /* */ }
    clientSock.destroy();
  });
}

// ── Relay server ──────────────────────────────────────────────────────────────

function createRelayServer(upstream: RelayUpstream): net.Server {
  return net.createServer((clientSock) => {
    clientSock.on("error", () => { /* ignore individual socket errors */ });

    let acc = Buffer.alloc(0);
    let parsed = false;

    const onData = (chunk: Buffer) => {
      if (parsed) return;
      acc = Buffer.concat([acc, chunk]);
      if (!acc.includes(Buffer.from("\r\n\r\n"))) return;

      parsed = true;
      clientSock.removeListener("data", onData);

      const firstLine = acc.toString("utf8").split("\r\n")[0] ?? "";
      const isSocks5 = (upstream.protocol ?? "http") === "socks5";

      if (firstLine.startsWith("CONNECT ")) {
        const target = firstLine.split(" ")[1] ?? "";
        if (!upstream.host)  handleConnectDirect(clientSock, target, upstream.localAddress);
        else if (isSocks5)   handleConnectViaSocks5(clientSock, target, upstream);
        else                  handleConnectViaHttp(clientSock, target, upstream);
      } else {
        if (!upstream.host) {
          // Plain HTTP in direct mode — extract host:port from request line
          const urlMatch = firstLine.match(/^[A-Z]+ https?:\/\/([^/:]+)(?::(\d+))?/);
          const directTarget = urlMatch ? `${urlMatch[1]}:${urlMatch[2] ?? "80"}` : "";
          handleConnectDirect(clientSock, directTarget, upstream.localAddress);
        } else if (isSocks5) handleHttpViaSocks5(clientSock, acc, upstream);
        else                  handleHttpViaHttp(clientSock, acc, upstream);
      }
    };

    clientSock.on("data", onData);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the local port of a relay that forwards to `upstream`.
 * Creates one if it doesn't exist yet (or if the old one is no longer listening).
 */
export async function getOrCreateRelay(upstream: RelayUpstream): Promise<number> {
  const key = relayKey(upstream);
  const existing = relays.get(key);
  if (existing?.server.listening) return existing.port;
  if (existing) relays.delete(key);

  const server = createRelayServer(upstream);
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "0.0.0.0", () => {
      resolve((server.address() as net.AddressInfo).port);
    });
    server.on("error", reject);
  });

  relays.set(key, { server, port });
  console.log(`[proxyRelay] started on 0.0.0.0:${port} → ${upstream.protocol ?? "http"}://${upstream.host}:${upstream.port}`);
  return port;
}

/** True if the relay for this upstream is currently listening. */
export function isRelayActive(upstream: RelayUpstream): boolean {
  return relays.get(relayKey(upstream))?.server.listening === true;
}

/** Returns the local port of an active relay, or null if not running. */
export function getRelayPort(upstream: RelayUpstream): number | null {
  const e = relays.get(relayKey(upstream));
  return e?.server.listening ? e.port : null;
}

/** Tears down the relay for a specific upstream (if it exists). */
export async function stopRelay(upstream: RelayUpstream): Promise<void> {
  const key = relayKey(upstream);
  const entry = relays.get(key);
  if (!entry) return;
  await new Promise<void>((r) => entry.server.close(() => r()));
  relays.delete(key);
  console.log(`[proxyRelay] stopped relay → ${upstream.host}:${upstream.port}`);
}

/** Stops all running relays (call on server shutdown). */
export function stopAll(): void {
  for (const { server } of relays.values()) {
    try { server.close(); } catch { /**/ }
  }
  relays.clear();
}
