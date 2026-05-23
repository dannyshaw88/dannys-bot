/**
 * proxyRelay.ts — host-side HTTP proxy relay for Android emulators.
 *
 * Problem: Android's `settings put global http_proxy host:port` only accepts
 * plain host:port — it cannot carry credentials.  If the real upstream proxy
 * requires authentication, Android sends no Proxy-Authorization header and
 * gets a 407, so traffic silently falls back to a direct connection.
 *
 * Solution: for each device we start a lightweight TCP server on the Windows
 * host (0.0.0.0:random).  Android's system proxy is pointed at
 * <gateway-ip>:<relay-port> (no credentials).  The relay forwards every
 * request to the real upstream, injecting the Proxy-Authorization header
 * automatically.  Both CONNECT (HTTPS tunnels) and plain HTTP are supported.
 */

import * as net from "net";

interface Upstream {
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

function authHeader(user?: string, pass?: string): string | null {
  if (!user) return null;
  return `Basic ${Buffer.from(`${user}:${pass ?? ""}`).toString("base64")}`;
}

export async function startRelay(serial: string, upstream: Upstream): Promise<number> {
  stopRelayForDevice(serial);

  const server = net.createServer(socket => handleClient(socket, upstream));
  server.on("error", () => {});

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "0.0.0.0", () => resolve());
    server.once("error", reject);
  });

  const port = (server.address() as net.AddressInfo).port;
  relays.set(serial, { server, port });
  return port;
}

export function stopRelayForDevice(serial: string): void {
  const entry = relays.get(serial);
  if (entry) {
    try { entry.server.close(); } catch {}
    relays.delete(serial);
  }
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

    if (/^HTTP\/1[.01]\s+200\b/.test(resp)) {
      tunneled = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length > 0) client.write(rest);
      if (trailingBytes.length > 0) up.write(trailingBytes);
      client.pipe(up);
      up.pipe(client);
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
