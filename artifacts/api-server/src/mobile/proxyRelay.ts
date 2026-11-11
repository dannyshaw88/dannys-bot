/**
 * proxyRelay.ts — host-side HTTP proxy relay for Android emulators.
 *
 * Problem: Android's `settings put global http_proxy host:port` only accepts
 * plain host:port — it cannot carry credentials.  If the real upstream proxy
 * requires authentication, Android sends no Proxy-Authorization header and
 * gets a 407, so traffic silently falls back to a direct connection.
 *
 * Solution: for each device we start a lightweight TCP server on the Windows
 * host (127.0.0.1:random) and register an ADB reverse port-forward so that
 * Android's own localhost:PORT connects back through the ADB tunnel to the
 * host relay — no Windows Firewall rules needed.  Android is pointed at
 * 127.0.0.1:<relay-port> (no credentials).  The relay forwards every request
 * to the real upstream, injecting Proxy-Authorization automatically.  Both
 * CONNECT (HTTPS tunnels) and plain HTTP are supported.
 */

import * as net from "net";

interface Upstream {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  protocol?: "http" | "socks5";
}

interface RelayEntry {
  server: net.Server;
  port: number;
  sockets: Set<net.Socket>;
}

const relays = new Map<string, RelayEntry>();

function authHeader(user?: string, pass?: string): string | null {
  if (!user) return null;
  return `Basic ${Buffer.from(`${user}:${pass ?? ""}`).toString("base64")}`;
}

export async function startRelay(serial: string, upstream: Upstream): Promise<number> {
  stopRelayForDevice(serial);

  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleClient(socket, upstream);
  });
  server.on("error", () => {});

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const port = (server.address() as net.AddressInfo).port;
  relays.set(serial, { server, port, sockets });
  return port;
}

export function stopRelayForDevice(serial: string): void {
  const entry = relays.get(serial);
  if (entry) {
    try { entry.server.close(); } catch {}
    for (const socket of entry.sockets) {
      try { socket.destroy(); } catch {}
    }
    relays.delete(serial);
  }
}

export function getRelayPort(serial: string): number | null {
  return relays.get(serial)?.port ?? null;
}

export async function stopRelay(
  _opts?: { host?: string; port?: number; user?: string; pass?: string; protocol?: string },
): Promise<void> {
  // No-op stub kept for legacy call sites; real cleanup is done per-device via stopRelayForDevice.
}

function handleClient(client: net.Socket, upstream: Upstream): void {
  client.on("error", () => {});

  const auth = authHeader(upstream.user, upstream.pass);

  let buf = Buffer.alloc(0);
  let dispatched = false;

  const onData = (chunk: Buffer): void => {
    if (dispatched) return;
    buf = Buffer.concat([buf, chunk]);

    const sep = buf.indexOf("\r\n\r\n");
    if (sep === -1) return;

    dispatched = true;
    client.removeListener("data", onData);

    const header = buf.slice(0, sep).toString("utf8");
    const trailing = buf.slice(sep + 4);
    const firstLine = header.split("\r\n")[0] ?? "";

    if (firstLine.startsWith("CONNECT ")) {
      handleConnect(client, firstLine, trailing, upstream, auth);
    } else {
      handleHttp(client, header, trailing, upstream, auth);
    }
  };

  client.on("data", onData);
}

function handleConnect(
  client: net.Socket,
  connectLine: string,
  trailingBytes: Buffer,
  upstream: Upstream,
  auth: string | null,
): void {
  if (upstream.protocol === "socks5") {
    const destination = connectLine.slice("CONNECT ".length).split(" ")[0] ?? "";
    const separator = destination.lastIndexOf(":");
    const targetHost = separator > 0 ? destination.slice(0, separator) : destination;
    const targetPort = separator > 0 ? Number(destination.slice(separator + 1)) : 443;
    void connectSocks5(upstream, targetHost, targetPort)
      .then(up => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (trailingBytes.length > 0) up.write(trailingBytes);
        pipeTunnel(client, up);
      })
      .catch(error => {
        console.warn(`[proxyRelay] SOCKS5 CONNECT failed: ${error instanceof Error ? error.message : String(error)}`);
        try { client.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch {}
        client.destroy();
      });
    return;
  }

  const up = net.createConnection(upstream.port, upstream.host);
  up.on("error", () => { try { client.destroy(); } catch {} });
  client.on("error", () => { try { up.destroy(); } catch {} });

  up.once("connect", () => {
    let req = connectLine + "\r\n";
    if (auth) req += `Proxy-Authorization: ${auth}\r\n`;
    req += "Proxy-Connection: keep-alive\r\n\r\n";
    up.write(req);
  });

  let upBuf = Buffer.alloc(0);
  let tunneled = false;

  up.on("data", (chunk: Buffer) => {
    if (tunneled) { client.write(chunk); return; }

    upBuf = Buffer.concat([upBuf, chunk]);
    const sep = upBuf.indexOf("\r\n\r\n");
    if (sep === -1) return;

    const resp = upBuf.slice(0, sep).toString("utf8");
    const rest = upBuf.slice(sep + 4);
    if (/^HTTP\/1\.[01]\s+200\b/.test(resp)) {
      tunneled = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length > 0) client.write(rest);
      if (trailingBytes.length > 0) up.write(trailingBytes);
      client.on("data", chunk => up.write(chunk));
    } else {
      client.write(resp + "\r\n\r\n");
      client.destroy();
      up.destroy();
    }
  });

  client.on("close", () => { try { up.destroy(); } catch {} });
  up.on("close", () => { try { client.destroy(); } catch {} });
}

function handleHttp(
  client: net.Socket,
  header: string,
  trailing: Buffer,
  upstream: Upstream,
  auth: string | null,
): void {
  if (upstream.protocol === "socks5") {
    handleSocks5Http(client, header, trailing, upstream);
    return;
  }

  const lines = header.split("\r\n").filter(
    l => !l.toLowerCase().startsWith("proxy-authorization:"),
  );
  if (auth) lines.splice(1, 0, `Proxy-Authorization: ${auth}`);

  const up = net.createConnection(upstream.port, upstream.host);
  up.on("error", () => { try { client.destroy(); } catch {} });
  client.on("error", () => { try { up.destroy(); } catch {} });

  up.once("connect", () => {
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (trailing.length > 0) up.write(trailing);
  });

  up.pipe(client);
  client.pipe(up);

  client.on("close", () => { try { up.destroy(); } catch {} });
  up.on("close", () => { try { client.destroy(); } catch {} });
}

function handleSocks5Http(
  client: net.Socket,
  header: string,
  trailing: Buffer,
  upstream: Upstream,
): void {
  const lines = header.split("\r\n");
  const [method, rawTarget, version] = (lines[0] ?? "").split(" ");
  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch {
    client.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    client.destroy();
    return;
  }

  if (!/^https?:$/.test(target.protocol)) {
    client.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    client.destroy();
    return;
  }

  const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const path = `${target.pathname || "/"}${target.search}`;
  const forwardHeaders = lines.slice(1).filter(
    line => !/^proxy-(authorization|connection):/i.test(line),
  );
  const request = [`${method} ${path} ${version || "HTTP/1.1"}`, ...forwardHeaders].join("\r\n") + "\r\n\r\n";

  void connectSocks5(upstream, target.hostname, targetPort)
    .then(up => {
      up.write(request);
      if (trailing.length > 0) up.write(trailing);
      pipeTunnel(client, up);
    })
    .catch(error => {
      console.warn(`[proxyRelay] SOCKS5 HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
      try { client.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch {}
      client.destroy();
    });
}

function pipeTunnel(client: net.Socket, upstream: net.Socket): void {
  client.on("error", () => { try { upstream.destroy(); } catch {} });
  upstream.on("error", () => { try { client.destroy(); } catch {} });
  client.on("close", () => { try { upstream.destroy(); } catch {} });
  upstream.on("close", () => { try { client.destroy(); } catch {} });
  client.pipe(upstream);
  upstream.pipe(client);
}

async function connectSocks5(upstream: Upstream, targetHost: string, targetPort: number): Promise<net.Socket> {
  if (!targetHost || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error(`Invalid SOCKS5 destination: ${targetHost}:${targetPort}`);
  }
  return openSocks5Tunnel(upstream, targetHost, targetPort);
}

async function openSocks5Tunnel(
  upstream: Upstream,
  targetHost: string,
  targetPort: number,
): Promise<net.Socket> {
  const socket = net.createConnection(upstream.port, upstream.host);
  socket.setTimeout(15_000, () => socket.destroy(new Error("SOCKS5 handshake timed out")));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    const hasCredentials = Boolean(upstream.user);
    socket.write(hasCredentials ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
    const greeting = await readExactly(socket, 2);
    if (greeting[0] !== 5 || greeting[1] === 0xff) {
      throw new Error("SOCKS5 upstream rejected available authentication methods");
    }

    if (greeting[1] === 2) {
      if (!hasCredentials) throw new Error("SOCKS5 upstream requires credentials");
      const user = Buffer.from(upstream.user ?? "");
      const pass = Buffer.from(upstream.pass ?? "");
      if (user.length > 255 || pass.length > 255) throw new Error("SOCKS5 credentials exceed protocol limits");
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
      const auth = await readExactly(socket, 2);
      if (auth[0] !== 1 || auth[1] !== 0) throw new Error("SOCKS5 authentication failed");
    } else if (greeting[1] !== 0) {
      throw new Error(`SOCKS5 upstream selected unsupported auth method ${greeting[1]}`);
    }

    const domain = Buffer.from(targetHost);
    if (!domain.length || domain.length > 255) throw new Error("SOCKS5 destination hostname is invalid");
    const port = Buffer.from([targetPort >> 8, targetPort & 0xff]);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, port]));

    const reply = await readExactly(socket, 4);
    if (reply[0] !== 5 || reply[1] !== 0) {
      throw new Error(`SOCKS5 CONNECT failed with reply ${reply[1]}`);
    }
    const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3
      ? (await readExactly(socket, 1))[0]
      : -1;
    if (addressLength < 0) throw new Error("SOCKS5 upstream returned an invalid address type");
    await readExactly(socket, addressLength + 2);
    socket.setTimeout(0);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

const socks5BufferedData = new WeakMap<net.Socket, Buffer>();

function readExactly(socket: net.Socket, length: number): Promise<Buffer> {
  const pending = socks5BufferedData.get(socket) ?? Buffer.alloc(0);
  if (pending.length >= length) {
    const result = pending.subarray(0, length);
    const remainder = pending.subarray(length);
    if (remainder.length > 0) socks5BufferedData.set(socket, remainder);
    else socks5BufferedData.delete(socket);
    return Promise.resolve(result);
  }

  return new Promise((resolve, reject) => {
    let data = pending;
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length < length) return;
      cleanup();
      const result = data.subarray(0, length);
      const remainder = data.subarray(length);
      if (remainder.length > 0) socks5BufferedData.set(socket, remainder);
      else socks5BufferedData.delete(socket);
      resolve(result);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("SOCKS5 upstream closed during handshake")); };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}
