/**
 * hotspotRelay.ts — per-account HTTP relay bound to a USB-tethered adapter.
 *
 * When a phone is tethered via USB, Windows creates a separate network adapter
 * (usually "USB Tethering", "RNDIS", or "Remote NDIS Based Internet Sharing Device").
 * This relay starts a plain HTTP proxy (CONNECT + plain HTTP) bound to that
 * adapter's IP address.  Because the listening socket is bound to the tethered
 * adapter's IP, all outbound connections from the relay exit through that adapter
 * — i.e. through the phone — leaving the machine's main network connection
 * completely untouched.
 *
 * The relay is shared across all accounts that have useHotspot=true pointing at
 * the same adapter.  It is keyed by adapter IP.
 */

import * as net from "net";
import * as os from "os";

export interface AdapterInfo {
  name: string;
  ip: string;
  /** Heuristic score — higher = more likely to be a USB tethering adapter */
  score: number;
  hint: string;
}

interface RelayEntry {
  server: net.Server;
  port: number;
  bindIp: string;
  refCount: number;
}

const relays = new Map<string, RelayEntry>();

// ── Adapter detection ────────────────────────────────────────────────────────

/**
 * Returns all non-internal IPv4 adapters, sorted by how likely they are to be
 * a USB-tethered phone.  Call this from the API route to show the user a picker.
 */
export function listAdapters(): AdapterInfo[] {
  const ifaces = os.networkInterfaces();
  const results: AdapterInfo[] = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue;

      let score = 0;
      const nameLower = name.toLowerCase();
      const hints: string[] = [];

      // Strong USB-tethering signals
      if (/rndis|usb.*ether|remote ndis/i.test(name))       { score += 40; hints.push("RNDIS/USB Ethernet"); }
      if (/usb.*tether|tether.*usb/i.test(name))            { score += 50; hints.push("USB Tethering"); }
      if (/bluetooth.*pan|pan.*bluetooth/i.test(name))      { score += 20; hints.push("Bluetooth PAN"); }
      // Android USB tethering almost always assigns 192.168.42.x or 192.168.43.x
      if (/^192\.168\.(42|43)\./.test(addr.address))        { score += 30; hints.push("Android subnet"); }
      // iPhone USB tethering uses 172.20.10.x
      if (/^172\.20\.10\./.test(addr.address))              { score += 30; hints.push("iPhone subnet"); }
      // Generic USB adapter name patterns
      if (/usb/i.test(name) && !/virtual|vmware|vbox|hyper/i.test(name)) { score += 15; hints.push("USB adapter"); }
      // Penalise known virtual / VPN adapters
      if (/vmware|vbox|virtual|hyper-v|loopback|tap|tun/i.test(name)) score -= 30;
      // Penalise WiFi adapters
      if (/wi-?fi|wireless|802\.11/i.test(name)) score -= 10;

      results.push({
        name,
        ip: addr.address,
        score,
        hint: hints.join(", ") || "Unknown adapter",
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// ── Relay lifecycle ───────────────────────────────────────────────────────────

/**
 * Start (or reuse) a relay bound to the given adapter IP.
 * Returns the relay port.  Multiple profiles can share the same relay.
 */
export async function startRelay(bindIp: string): Promise<number> {
  const existing = relays.get(bindIp);
  if (existing) {
    existing.refCount++;
    return existing.port;
  }

  const server = net.createServer(socket => handleClient(socket, bindIp));
  server.on("error", () => {});

  await new Promise<void>((resolve, reject) => {
    server.listen(0, bindIp, () => resolve());
    server.once("error", reject);
  });

  const port = (server.address() as net.AddressInfo).port;
  relays.set(bindIp, { server, port, bindIp, refCount: 1 });
  console.log(`[hotspotRelay] relay started on ${bindIp}:${port}`);
  return port;
}

/**
 * Decrement ref count; shut the relay down when no one is using it.
 */
export function releaseRelay(bindIp: string): void {
  const entry = relays.get(bindIp);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    try { entry.server.close(); } catch {}
    relays.delete(bindIp);
    console.log(`[hotspotRelay] relay on ${bindIp} stopped (no more users)`);
  }
}

export function getRelayPort(bindIp: string): number | null {
  return relays.get(bindIp)?.port ?? null;
}

export function getAllRelays(): Array<{ bindIp: string; port: number; refCount: number }> {
  return [...relays.values()].map(({ bindIp, port, refCount }) => ({ bindIp, port, refCount }));
}

// ── HTTP proxy implementation (CONNECT + plain HTTP) ────────────────────────
// The key detail: outbound `net.createConnection` calls don't specify a local
// address, so Node uses the default route.  To force traffic out through the
// tethered adapter we pass `localAddress: bindIp` on every outbound socket.

function handleClient(client: net.Socket, bindIp: string): void {
  client.on("error", () => {});

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
      handleConnect(client, firstLine, trailing, bindIp);
    } else {
      handleHttp(client, header, trailing, bindIp);
    }
  };

  client.on("data", onData);
}

function parseHostPort(authority: string): { host: string; port: number } | null {
  const lastColon = authority.lastIndexOf(":");
  if (lastColon === -1) return null;
  const host = authority.slice(0, lastColon);
  const port = parseInt(authority.slice(lastColon + 1), 10);
  if (!host || isNaN(port)) return null;
  return { host, port };
}

function handleConnect(
  client: net.Socket,
  connectLine: string,
  trailingBytes: Buffer,
  bindIp: string,
): void {
  // CONNECT host:port HTTP/1.1
  const parts = connectLine.split(" ");
  const authority = parts[1] ?? "";
  const target = parseHostPort(authority);
  if (!target) { client.destroy(); return; }

  const up = net.createConnection({ port: target.port, host: target.host, localAddress: bindIp });
  up.on("error", () => { try { client.destroy(); } catch {} });
  client.on("error", () => { try { up.destroy(); } catch {} });

  up.once("connect", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (trailingBytes.length > 0) up.write(trailingBytes);
    client.pipe(up);
    up.pipe(client);
  });

  client.on("close", () => { try { up.destroy(); } catch {} });
  up.on("close", () => { try { client.destroy(); } catch {} });
}

function handleHttp(
  client: net.Socket,
  header: string,
  trailing: Buffer,
  bindIp: string,
): void {
  const lines = header.split("\r\n");
  const firstLine = lines[0] ?? "";
  // Extract host from the request URL or Host header
  let host = "";
  let port = 80;

  const urlMatch = firstLine.match(/^[A-Z]+\s+http:\/\/([^/:]+)(?::(\d+))?/i);
  if (urlMatch) {
    host = urlMatch[1];
    if (urlMatch[2]) port = parseInt(urlMatch[2], 10);
  } else {
    const hostHeader = lines.find(l => /^host:/i.test(l));
    if (hostHeader) {
      const val = hostHeader.replace(/^host:\s*/i, "").trim();
      const hp = parseHostPort(val);
      if (hp) { host = hp.host; port = hp.port; }
      else host = val;
    }
  }

  if (!host) { client.destroy(); return; }

  const up = net.createConnection({ port, host, localAddress: bindIp });
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
