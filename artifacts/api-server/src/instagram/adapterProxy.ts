/**
 * adapterProxy.ts
 *
 * Built-in local HTTP CONNECT tunnel server that routes outbound TCP connections
 * through a specific network adapter (by binding to its localAddress).
 *
 * One server per proxy row with proxyType="adapter". The server listens on
 * 127.0.0.1:<dynamic port> and forwards all CONNECT requests out through the
 * adapter IP so only traffic explicitly sent through this proxy uses the
 * 4G/dongle connection — everything else stays on the default route.
 *
 * IP rotation: toggle the adapter off (OS reconnect) — no app restart needed.
 * The tunnel always binds to the CURRENT IP of the named adapter, so after
 * reconnection traffic automatically flows through the new IP.
 */

import net from "net";
import os from "os";
import dns from "dns";
import { exec } from "child_process";
import { promisify } from "util";

const dnsLookup = promisify(dns.lookup);

const execAsync = promisify(exec);

export interface AdapterInfo {
  name: string;
  /** IPv4 address, or empty string if the adapter has no IPv4 address currently assigned. */
  ip: string;
  family: "IPv4";
  internal: boolean;
}

/**
 * Returns all non-loopback network interfaces.
 * Adapters without an IPv4 address are included with ip="" so they still
 * appear in the UI (e.g. a 4G dongle that Windows sees as a wireless adapter
 * but hasn't been assigned an address yet).
 */
export function listAdapters(): AdapterInfo[] {
  const ifaces = os.networkInterfaces();
  const result: AdapterInfo[] = [];
  const seen = new Set<string>();

  for (const [name, addrs] of Object.entries(ifaces ?? {})) {
    if (!addrs) continue;

    // Skip purely loopback adapters (every address is internal)
    const nonInternal = addrs.filter(a => !a.internal);
    if (nonInternal.length === 0) continue;

    // Prefer the IPv4 address if one exists
    const ipv4 = nonInternal.find(a => a.family === "IPv4");

    if (ipv4) {
      if (!seen.has(name)) {
        seen.add(name);
        result.push({ name, ip: ipv4.address, family: "IPv4", internal: false });
      }
    } else {
      // Adapter exists but has no IPv4 (e.g. IPv6-only, or not yet assigned)
      if (!seen.has(name)) {
        seen.add(name);
        result.push({ name, ip: "", family: "IPv4", internal: false });
      }
    }
  }
  return result;
}

/** Returns the current IPv4 address for a named adapter, or null if unplugged. */
export function getAdapterIp(adapterName: string): string | null {
  const ifaces = os.networkInterfaces();
  const addrs = ifaces?.[adapterName];
  if (!addrs) return null;
  const ipv4 = addrs.find(a => a.family === "IPv4" && !a.internal);
  return ipv4?.address ?? null;
}

interface TunnelServer {
  proxyId: number;
  adapterName: string;
  port: number;
  server: net.Server;
  rotateTimer?: NodeJS.Timeout;
}

const servers = new Map<number, TunnelServer>();

/**
 * Start (or restart) a local CONNECT tunnel for the given proxy row.
 * Returns the local port it bound to.
 */
export async function startAdapterProxy(proxyId: number, adapterName: string): Promise<number> {
  await stopAdapterProxy(proxyId);

  return new Promise((resolve, reject) => {
    const server = net.createServer(clientSocket => {
      let buffer = Buffer.alloc(0);
      let handshakeDone = false;

      clientSocket.on("data", (chunk: Buffer) => {
        if (handshakeDone) return;
        buffer = Buffer.concat([buffer, chunk]);
        const str = buffer.toString();
        const headEnd = str.indexOf("\r\n\r\n");
        if (headEnd === -1) return;

        handshakeDone = true;
        const head = str.slice(0, headEnd);
        const firstLine = head.split("\r\n")[0] ?? "";
        const [method, hostPort] = firstLine.split(" ");

        if (method !== "CONNECT" || !hostPort) {
          clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
          clientSocket.destroy();
          return;
        }

        const lastColon = hostPort.lastIndexOf(":");
        const targetHost = hostPort.slice(0, lastColon);
        const targetPort = parseInt(hostPort.slice(lastColon + 1), 10);

        const currentIp = getAdapterIp(adapterName);
        if (!currentIp) {
          clientSocket.write("HTTP/1.1 503 Adapter Unavailable\r\n\r\n");
          clientSocket.destroy();
          return;
        }

        // Resolve the target hostname to an IPv4 address before connecting.
        // net.createConnection with a hostname triggers dns.lookup() which uses
        // the OS default resolver — typically routed through the main broadband
        // interface (lower metric) rather than the 4G dongle.  By resolving
        // explicitly with family:4 here and then passing the raw IP to
        // createConnection, we (a) force IPv4, (b) avoid a second silent
        // dns.lookup() inside Node.js, and (c) get clearer error messages if
        // DNS itself fails.
        const resolveAndConnect = async () => {
          let resolvedHost = targetHost;
          if (!net.isIP(targetHost)) {
            try {
              const { address } = await dnsLookup(targetHost, { family: 4 });
              resolvedHost = address;
            } catch (dnsErr: any) {
              clientSocket.write("HTTP/1.1 502 DNS Resolution Failed\r\n\r\n");
              clientSocket.destroy();
              console.warn(`[adapter] DNS lookup failed for "${targetHost}": ${dnsErr?.message ?? dnsErr}`);
              return;
            }
          }

          const remote = net.createConnection(
            { host: resolvedHost, port: targetPort, localAddress: currentIp },
            () => {
              clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
              remote.pipe(clientSocket);
              clientSocket.pipe(remote);
            }
          );

          remote.on("error", (err) => {
            console.warn(`[adapter] CONNECT to ${resolvedHost}:${targetPort} via ${currentIp} failed: ${(err as any)?.message ?? err}`);
            clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
            clientSocket.destroy();
          });
          clientSocket.on("error", () => remote.destroy());
          remote.on("close", () => clientSocket.destroy());
          clientSocket.on("close", () => remote.destroy());
        };

        resolveAndConnect().catch(() => {
          try { clientSocket.write("HTTP/1.1 500 Internal Error\r\n\r\n"); } catch {}
          clientSocket.destroy();
        });
      });

      clientSocket.on("error", () => {});
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      servers.set(proxyId, { proxyId, adapterName, port: addr.port, server });
      resolve(addr.port);
    });

    server.on("error", reject);
  });
}

export async function stopAdapterProxy(proxyId: number): Promise<void> {
  const existing = servers.get(proxyId);
  if (!existing) return;
  clearInterval(existing.rotateTimer);
  await new Promise<void>(resolve => existing.server.close(() => resolve()));
  servers.delete(proxyId);
}

export function getAdapterProxyPort(proxyId: number): number | null {
  return servers.get(proxyId)?.port ?? null;
}

export function isAdapterProxyRunning(proxyId: number): boolean {
  return servers.has(proxyId);
}

/**
 * Schedule automatic IP rotation for an adapter proxy.
 * Rotation = call the OS to disconnect/reconnect the adapter, which causes
 * the carrier to assign a new IP. We do this via a dummy TCP close to the
 * adapter's gateway — sufficient to trigger a DHCP renew on most 4G dongles.
 * The tunnel itself does NOT need to restart — it rebinds localAddress on
 * every new connection dynamically.
 */
export function scheduleRotation(
  proxyId: number,
  adapterName: string,
  intervalMs: number,
  onRotate: (proxyId: number, adapterName: string) => void,
): void {
  const existing = servers.get(proxyId);
  if (!existing) return;
  clearInterval(existing.rotateTimer);
  existing.rotateTimer = setInterval(() => {
    onRotate(proxyId, adapterName);
  }, intervalMs);
}

export function clearRotation(proxyId: number): void {
  const existing = servers.get(proxyId);
  if (!existing) return;
  clearInterval(existing.rotateTimer);
  existing.rotateTimer = undefined;
}

export async function stopAllAdapterProxies(): Promise<void> {
  for (const id of servers.keys()) {
    await stopAdapterProxy(id);
  }
}

/**
 * Disconnect and reconnect a network adapter to force the carrier to assign a
 * new IP address — the same thing a phone does when you toggle Airplane mode.
 *
 * On Windows: uses `netsh interface set interface` to disable the adapter for
 * 30 seconds then re-enable it. Requires the Electron app to be running with
 * administrator privileges (which electron-builder's NSIS installer enables).
 *
 * The tunnel server does NOT need to restart — it reads getAdapterIp() on
 * every new connection, so it automatically picks up the new IP after reconnect.
 *
 * Non-blocking: fires the async sequence and returns immediately.
 */
export function rotateAdapter(adapterName: string, onDone?: (newIp: string | null) => void): void {
  (async () => {
    try {
      console.log(`[adapter] Rotating "${adapterName}" — disabling...`);
      await execAsync(`netsh interface set interface "${adapterName}" disable`);
      console.log(`[adapter] "${adapterName}" disabled — waiting 30 s for carrier reassignment...`);
      await new Promise(r => setTimeout(r, 30_000));
      await execAsync(`netsh interface set interface "${adapterName}" enable`);
      // Give the OS a moment to obtain the new DHCP lease
      await new Promise(r => setTimeout(r, 3_000));
      const newIp = getAdapterIp(adapterName);
      console.log(`[adapter] "${adapterName}" re-enabled — new IP: ${newIp ?? "unknown"}`);
      onDone?.(newIp);
    } catch (err) {
      console.warn(`[adapter] Rotation failed for "${adapterName}":`, err);
      onDone?.(null);
    }
  })();
}
