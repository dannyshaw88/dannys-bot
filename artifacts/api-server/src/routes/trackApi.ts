import type { Express } from "express";
import type { Server as HttpServer } from "http";
import * as net from "net";
import * as http from "http";
import * as https from "https";
import * as http2 from "http2";
import * as tls from "tls";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as forge from "node-forge";
import { WebSocketServer, WebSocket } from "ws";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrackLogEntry {
  id: number;
  ts: string;
  method: string;
  host: string;
  path: string;
  label: string | null;
  status: number | null;
  durationMs: number | null;
  type: "http" | "connect" | "https";
  size: number | null;
}

// ─── Instagram endpoint label map ─────────────────────────────────────────────

const IG_LABELS: Array<[RegExp, string]> = [
  [/^\/api\/v1\/feed\/timeline\//,                        "Timeline Feed"],
  [/^\/api\/v1\/feed\/reels_tray\//,                      "Stories Tray"],
  [/^\/api\/v1\/feed\/reels_media\//,                     "Reels Media"],
  [/^\/api\/v1\/feed\/user\//,                            "User Feed"],
  [/^\/api\/v1\/feed\/liked\//,                           "Liked Posts"],
  [/^\/api\/v1\/feed\/saved\//,                           "Saved Posts"],
  [/^\/api\/v1\/feed\/tag\//,                             "Hashtag Feed"],
  [/^\/api\/v1\/feed\/location\//,                        "Location Feed"],
  [/^\/api\/v1\/feed\/collection\//,                      "Collection Feed"],
  [/^\/api\/v1\/friendships\/create\//,                   "Follow User"],
  [/^\/api\/v1\/friendships\/destroy\//,                  "Unfollow User"],
  [/^\/api\/v1\/friendships\/show\//,                     "Friendship Status"],
  [/^\/api\/v1\/friendships\/show_many\//,                "Friendship Status (Bulk)"],
  [/^\/api\/v1\/friendships\/pending\//,                  "Follow Requests"],
  [/^\/api\/v1\/friendships\/approve\//,                  "Approve Follow"],
  [/^\/api\/v1\/friendships\/ignore\//,                   "Ignore Follow"],
  [/^\/api\/v1\/friendships\/block\//,                    "Block User"],
  [/^\/api\/v1\/friendships\/unblock\//,                  "Unblock User"],
  [/\/followers\//,                                       "Followers List"],
  [/\/following\//,                                       "Following List"],
  [/^\/api\/v1\/media\/[^/]+\/like\//,                   "Like Post"],
  [/^\/api\/v1\/media\/[^/]+\/unlike\//,                 "Unlike Post"],
  [/^\/api\/v1\/media\/[^/]+\/save\//,                   "Save Post"],
  [/^\/api\/v1\/media\/[^/]+\/unsave\//,                 "Unsave Post"],
  [/^\/api\/v1\/media\/[^/]+\/comments\//,               "View Comments"],
  [/^\/api\/v1\/media\/[^/]+\/comment\//,                "Post Comment"],
  [/^\/api\/v1\/media\/[^/]+\/info\//,                   "Post Info"],
  [/^\/api\/v1\/media\/[^/]+\/edit\//,                   "Edit Post"],
  [/^\/api\/v1\/media\/[^/]+\/delete\//,                 "Delete Post"],
  [/^\/api\/v1\/media\/[^/]+\/likers\//,                 "Post Likers"],
  [/^\/api\/v1\/media\/upload\//,                        "Upload Media"],
  [/^\/api\/v1\/media\/configure\//,                     "Publish Post"],
  [/^\/api\/v1\/direct_v2\/inbox\//,                     "DM Inbox"],
  [/^\/api\/v1\/direct_v2\/pending_inbox\//,             "DM Pending"],
  [/^\/api\/v1\/direct_v2\/threads\//,                   "DM Thread"],
  [/^\/api\/v1\/direct_v2\/create_group_thread\//,       "Create Group DM"],
  [/broadcast\/text\//,                                   "Send DM"],
  [/broadcast\/link\//,                                   "Send Link DM"],
  [/broadcast\/media_share\//,                            "Share Post DM"],
  [/broadcast\/reaction\//,                               "React to DM"],
  [/^\/api\/v1\/users\/[^/]+\/info\//,                   "User Info"],
  [/^\/api\/v1\/users\/search\//,                        "Search Users"],
  [/^\/api\/v1\/users\/[^/]+\/full_detail_info\//,       "User Detail Info"],
  [/^\/api\/v1\/usertags\/[^/]+\/feed\//,                "Tagged Posts"],
  [/^\/api\/v1\/accounts\/login\//,                      "Login"],
  [/^\/api\/v1\/accounts\/logout\//,                     "Logout"],
  [/^\/api\/v1\/accounts\/create\//,                     "Create Account"],
  [/^\/api\/v1\/accounts\/set_biography\//,              "Update Bio"],
  [/^\/api\/v1\/accounts\/change_profile_picture\//,     "Update Profile Pic"],
  [/^\/api\/v1\/accounts\/edit_profile\//,               "Edit Profile"],
  [/^\/api\/v1\/accounts\/current_user\//,               "Current User Info"],
  [/^\/api\/v1\/discover\/topical_explore\//,            "Explore Page"],
  [/^\/api\/v1\/discover\/channels_home\//,              "Explore Channels"],
  [/^\/api\/v1\/news\/inbox\//,                          "Activity / Notifications"],
  [/^\/api\/v1\/igtv\//,                                 "IGTV"],
  [/^\/api\/v1\/clips\//,                                "Reels"],
  [/^\/api\/v1\/clips\/reels_tab\//,                     "Reels Tab"],
  [/^\/api\/v1\/highlights\//,                           "Highlights"],
  [/^\/api\/v1\/web\/[^/]+\/save\//,                     "Save Story"],
  [/^\/api\/v1\/location_search\//,                      "Location Search"],
  [/^\/api\/v1\/tags\/search\//,                         "Hashtag Search"],
  [/^\/api\/v1\/launcher\/sync\//,                       "Launcher Sync"],
  [/^\/api\/v1\/qe\/expose\//,                           "QE Expose"],
  [/^\/api\/v1\/scores\/bootstrap\//,                    "Score Bootstrap"],
  [/^\/api\/v1\/banyan\/banyan\//,                       "Banyan (Suggested)"],
  [/^\/api\/v1\/push\/register\//,                       "Push Register"],
  [/^\/api\/v1\/attribution\//,                          "Attribution"],
  [/^\/api\/v1\/language\//,                             "Language / Locale"],
  [/^\/api\/v1\/logging\//,                              "App Logging"],
  [/^\/api\/v1\/business_conversion\//,                  "Business Conversion"],
  [/^\/graphql\//,                                       "GraphQL"],
  [/^\/api\/graphql\//,                                  "GraphQL"],
];

function labelForPath(p: string): string | null {
  if (!p) return null;
  for (const [re, label] of IG_LABELS) {
    if (re.test(p)) return label;
  }
  return null;
}

// ─── In-memory log store ──────────────────────────────────────────────────────

const MAX_ENTRIES = 2000;
let _nextId = 1;
const _log: TrackLogEntry[] = [];
const _clients = new Set<WebSocket>();

function pushEntry(entry: Omit<TrackLogEntry, "id" | "ts">) {
  const full: TrackLogEntry = { id: _nextId++, ts: new Date().toISOString(), ...entry };
  _log.push(full);
  if (_log.length > MAX_ENTRIES) _log.splice(0, _log.length - MAX_ENTRIES);
  const msg = JSON.stringify({ type: "entry", entry: full });
  for (const ws of _clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ─── Certificate authority & per-domain cert cache ────────────────────────────

let _caKey: forge.pki.rsa.PrivateKey | null = null;
let _caCert: forge.pki.Certificate | null = null;
const _certCache = new Map<string, { key: string; cert: string }>();

function getCaDir(): string {
  const dbPath = process.env.DATABASE_PATH;
  if (dbPath) return path.dirname(dbPath);
  return path.join(process.cwd(), "browser-data");
}

const CA_KEY_PATH = () => path.join(getCaDir(), "track-api-ca-key.pem");
const CA_CERT_PATH = () => path.join(getCaDir(), "track-api-ca-cert.pem");

function ensureDirExists(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureCa(): { caKey: forge.pki.rsa.PrivateKey; caCert: forge.pki.Certificate } {
  if (_caKey && _caCert) return { caKey: _caKey, caCert: _caCert };

  const keyPath = CA_KEY_PATH();
  const certPath = CA_CERT_PATH();
  ensureDirExists(path.dirname(keyPath));

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    try {
      const keyPem = fs.readFileSync(keyPath, "utf8");
      const certPem = fs.readFileSync(certPath, "utf8");
      _caKey = forge.pki.privateKeyFromPem(keyPem);
      _caCert = forge.pki.certificateFromPem(certPem);
      return { caKey: _caKey, caCert: _caCert };
    } catch {}
  }

  console.log("[track-api] Generating new CA certificate (first run, ~2s)…");
  const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keypair.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: "commonName", value: "Equinox Track API CA" },
    { name: "organizationName", value: "Equinox" },
    { name: "countryName", value: "US" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keypair.privateKey, forge.md.sha256.create());

  const keyPem = forge.pki.privateKeyToPem(keypair.privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  fs.writeFileSync(keyPath, keyPem);
  fs.writeFileSync(certPath, certPem);

  _caKey = keypair.privateKey;
  _caCert = cert;
  console.log("[track-api] CA certificate generated and saved.");
  return { caKey: _caKey, caCert: _caCert };
}

function getCertForHost(hostname: string): { key: string; cert: string } {
  const cached = _certCache.get(hostname);
  if (cached) return cached;

  const { caKey, caCert } = ensureCa();
  const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keypair.publicKey;
  cert.serialNumber = String(Date.now());
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

  cert.setSubject([{ name: "commonName", value: hostname }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "subjectAltName", altNames: [{ type: 2, value: hostname }] },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  const result = {
    key: forge.pki.privateKeyToPem(keypair.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
  _certCache.set(hostname, result);
  return result;
}

// ─── Instagram domain allowlist for MITM ─────────────────────────────────────

const INSTAGRAM_MITM_RE = /^(i\.instagram\.com|instagram\.com|www\.instagram\.com|graph\.instagram\.com|edge-chat\.instagram\.com|b\.i\.instagram\.com|api\.instagram\.com|business\.instagram\.com)$/i;

function isInstagramHost(host: string): boolean {
  return INSTAGRAM_MITM_RE.test(host);
}

// ─── MITM HTTPS handler ───────────────────────────────────────────────────────

function handleMitmConnect(clientSocket: net.Socket, host: string, port: number) {
  let domainCreds: { key: string; cert: string };
  try {
    domainCreds = getCertForHost(host);
  } catch (err) {
    // Can't generate cert — fall back to pass-through tunnel
    handlePassthroughConnect(clientSocket, host, port);
    return;
  }

  const tlsServer = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key: domainCreds.key,
    cert: domainCreds.cert,
    ALPNProtocols: ["http/1.1"],
  });

  tlsServer.on("error", () => { try { clientSocket.destroy(); } catch {} });

  // Buffer data until TLS is established
  tlsServer.on("secure", () => {
    handleDecryptedStream(tlsServer, host, port);
  });
}

function handleDecryptedStream(decryptedSocket: tls.TLSSocket, host: string, destPort: number) {
  let headerBuf = Buffer.alloc(0);
  let headerDone = false;
  const chunks: Buffer[] = [];

  decryptedSocket.on("data", (chunk: Buffer) => {
    if (headerDone) return;
    headerBuf = Buffer.concat([headerBuf, chunk]);
    const headerEnd = headerBuf.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    headerDone = true;
    const headerStr = headerBuf.slice(0, headerEnd).toString("utf8");
    const body = headerBuf.slice(headerEnd + 4);
    const lines = headerStr.split("\r\n");
    const requestLine = lines[0] ?? "";
    const parts = requestLine.split(" ");
    const method = (parts[0] ?? "").toUpperCase();
    const rawPath = parts[1] ?? "/";

    const parsedPath = rawPath.startsWith("/") ? rawPath : (() => {
      try { return new URL(rawPath).pathname + (new URL(rawPath).search ?? ""); } catch { return rawPath; }
    })();

    const headers: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
      const idx = lines[i].indexOf(":");
      if (idx > 0) {
        headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
      }
    }

    const bodyLen = parseInt(headers["content-length"] ?? "0", 10);
    const start = Date.now();

    const isInstagram = /instagram\.com|i\.instagram\.com|graph\.instagram\.com/.test(host);
    const label = isInstagram ? labelForPath(parsedPath) : null;

    function doForward(reqBody: Buffer) {
      const options: https.RequestOptions = {
        hostname: host,
        port: destPort,
        path: parsedPath,
        method,
        headers: { ...headers, host },
        rejectUnauthorized: false,
      };
      delete (options.headers as any)["proxy-connection"];

      const proxyReq = https.request(options, (proxyRes) => {
        const status = proxyRes.statusCode ?? 0;
        const resChunks: Buffer[] = [];
        proxyRes.on("data", (c: Buffer) => resChunks.push(c));
        proxyRes.on("end", () => {
          const responseBody = Buffer.concat(resChunks);
          pushEntry({
            method,
            host,
            path: parsedPath,
            label,
            status,
            durationMs: Date.now() - start,
            type: "https",
            size: responseBody.length,
          });

          try {
            decryptedSocket.write(`HTTP/1.1 ${status} ${proxyRes.statusMessage}\r\n`);
            for (const [k, v] of Object.entries(proxyRes.headers)) {
              if (k.toLowerCase() === "transfer-encoding") continue;
              decryptedSocket.write(`${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`);
            }
            decryptedSocket.write(`content-length: ${responseBody.length}\r\n`);
            decryptedSocket.write("\r\n");
            decryptedSocket.write(responseBody);
            decryptedSocket.end();
          } catch {}
        });
      });
      proxyReq.on("error", () => { try { decryptedSocket.destroy(); } catch {} });
      if (reqBody.length) proxyReq.write(reqBody);
      proxyReq.end();
    }

    if (bodyLen > 0 && body.length < bodyLen) {
      chunks.push(body);
      let got = body.length;
      decryptedSocket.on("data", (c: Buffer) => {
        chunks.push(c);
        got += c.length;
        if (got >= bodyLen) {
          decryptedSocket.removeAllListeners("data");
          doForward(Buffer.concat(chunks));
        }
      });
    } else {
      doForward(body);
    }
  });

  decryptedSocket.on("error", () => { try { decryptedSocket.destroy(); } catch {} });
}

// ─── Pass-through TCP tunnel (non-Instagram or cert failure) ──────────────────

function handlePassthroughConnect(clientSocket: net.Socket, host: string, port: number) {
  pushEntry({ method: "CONNECT", host, path: "", label: null, status: null, durationMs: null, type: "connect", size: null });
  const destSocket = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    destSocket.pipe(clientSocket);
    clientSocket.pipe(destSocket);
  });
  destSocket.on("error", () => { try { clientSocket.destroy(); } catch {} });
  clientSocket.on("error", () => { try { destSocket.destroy(); } catch {} });
}

// ─── Plain HTTP proxy ─────────────────────────────────────────────────────────

function handlePlainHttp(
  clientSocket: net.Socket,
  method: string,
  target: string,
  lines: string[],
  headerBuf: Buffer,
  headerEnd: number
) {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(target.startsWith("http") ? target : `http://${target}`);
  } catch {
    clientSocket.destroy();
    return;
  }

  const destHost = parsedUrl.hostname;
  const destPort = parsedUrl.port ? parseInt(parsedUrl.port) : 80;
  const reqPath = parsedUrl.pathname + parsedUrl.search;
  const start = Date.now();
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(":");
    if (idx > 0) headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
  }

  const body = headerBuf.slice(headerEnd + 4);
  const bodyLen = parseInt(headers["content-length"] ?? "0", 10);
  const chunks: Buffer[] = [];

  function doRequest(reqBody: Buffer) {
    const proxyHeaders: Record<string, string> = { ...headers };
    delete proxyHeaders["proxy-connection"];
    proxyHeaders["connection"] = "close";

    const options: http.RequestOptions = {
      hostname: destHost, port: destPort, path: reqPath, method, headers: proxyHeaders,
    };
    const proxyReq = http.request(options, (proxyRes) => {
      const status = proxyRes.statusCode ?? 0;
      const resChunks: Buffer[] = [];
      proxyRes.on("data", (c: Buffer) => resChunks.push(c));
      proxyRes.on("end", () => {
        const responseBody = Buffer.concat(resChunks);
        pushEntry({ method, host: destHost, path: reqPath, label: labelForPath(reqPath), status, durationMs: Date.now() - start, type: "http", size: responseBody.length });
        try {
          clientSocket.write(`HTTP/1.1 ${status} ${proxyRes.statusMessage}\r\n`);
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            clientSocket.write(`${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`);
          }
          clientSocket.write("\r\n");
          clientSocket.write(responseBody);
          clientSocket.end();
        } catch {}
      });
    });
    proxyReq.on("error", () => { try { clientSocket.destroy(); } catch {} });
    if (reqBody.length) proxyReq.write(reqBody);
    proxyReq.end();
  }

  if (bodyLen > 0 && body.length < bodyLen) {
    chunks.push(body);
    let got = body.length;
    clientSocket.on("data", (c: Buffer) => {
      chunks.push(c);
      got += c.length;
      if (got >= bodyLen) { clientSocket.removeAllListeners("data"); doRequest(Buffer.concat(chunks)); }
    });
  } else {
    doRequest(body);
  }
}

// ─── Proxy server ─────────────────────────────────────────────────────────────

let _proxyServer: net.Server | null = null;
let _proxyPort = 8899;
let _mitmEnabled = true;

export interface LocalAdapter {
  ip: string;
  name: string;
  likely: boolean;
}

function getLocalAdapters(): LocalAdapter[] {
  const adapters: LocalAdapter[] = [];
  const ifaces = os.networkInterfaces();
  const VIRTUAL_PATTERNS = [
    /hyper-v/i, /vethernet/i, /virtualbox/i, /vmware/i, /vmnet/i,
    /docker/i, /loopback/i, /pseudo/i, /tunnel/i, /isatap/i, /teredo/i,
    /6to4/i, /wsl/i, /bluetooth/i,
  ];
  for (const [name, iface] of Object.entries(ifaces)) {
    for (const info of iface ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      const isVirtual = VIRTUAL_PATTERNS.some(p => p.test(name));
      const isPrivate192 = info.address.startsWith("192.168.");
      const isPrivate10 = info.address.startsWith("10.");
      const isPrivate172 = /^172\.(1[6-9]|2\d|3[01])\./.test(info.address);
      const isTypicalWifi = isPrivate192 || (isPrivate10 && !isVirtual) || (isPrivate172 && !isVirtual);
      adapters.push({ ip: info.address, name, likely: isTypicalWifi && !isVirtual });
    }
  }
  adapters.sort((a, b) => (b.likely ? 1 : 0) - (a.likely ? 1 : 0));
  return adapters;
}

function getLocalIps(): string[] {
  return getLocalAdapters().map(a => a.ip);
}

let _cachedPublicIp: string | null = null;
let _publicIpFetchedAt = 0;
const PUBLIC_IP_TTL_MS = 60_000;

function fetchPublicIp(): Promise<string | null> {
  return new Promise((resolve) => {
    const now = Date.now();
    if (_cachedPublicIp && now - _publicIpFetchedAt < PUBLIC_IP_TTL_MS) return resolve(_cachedPublicIp);
    const timeout = setTimeout(() => resolve(null), 3000);
    https.get("https://api.ipify.org", (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c.toString(); });
      res.on("end", () => {
        clearTimeout(timeout);
        const ip = data.trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
          _cachedPublicIp = ip;
          _publicIpFetchedAt = Date.now();
          resolve(ip);
        } else {
          resolve(null);
        }
      });
      res.on("error", () => { clearTimeout(timeout); resolve(null); });
    }).on("error", () => { clearTimeout(timeout); resolve(null); });
  });
}

function startProxy(port: number, mitm: boolean): Promise<void> {
  if (_proxyServer) return Promise.resolve();
  _proxyPort = port;
  _mitmEnabled = mitm;

  return new Promise((resolve, reject) => {
    const server = net.createServer((clientSocket) => {
      let headerBuf = Buffer.alloc(0);
      let headerDone = false;

      clientSocket.on("data", (chunk) => {
        if (headerDone) return;
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const headerEnd = headerBuf.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        headerDone = true;

        const headerStr = headerBuf.slice(0, headerEnd).toString("utf8");
        const lines = headerStr.split("\r\n");
        const requestLine = lines[0] ?? "";
        const parts = requestLine.split(" ");
        const method = parts[0]?.toUpperCase() ?? "";
        const target = parts[1] ?? "";

        if (method === "CONNECT") {
          const [host, portStr] = target.split(":");
          const destPort = parseInt(portStr ?? "443", 10);
          const h = host ?? target;

          // Only MITM Instagram domains — everything else gets a transparent tunnel
          if (_mitmEnabled && isInstagramHost(h)) {
            // Respond 200 first, THEN hand off to MITM handler
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            handleMitmConnect(clientSocket, h, destPort);
          } else {
            handlePassthroughConnect(clientSocket, h, destPort);
          }
        } else if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) {
          handlePlainHttp(clientSocket, method, target, lines, headerBuf, headerEnd);
        } else {
          clientSocket.destroy();
        }
      });

      clientSocket.on("error", () => {});
    });

    server.on("error", reject);
    server.listen(port, "0.0.0.0", () => {
      _proxyServer = server;
      console.log(`[track-api] Proxy started on port ${port} (MITM: ${mitm})`);
      resolve();
    });
  });
}

function stopProxy(): Promise<void> {
  return new Promise((resolve) => {
    if (!_proxyServer) { resolve(); return; }
    _proxyServer.close(() => { _proxyServer = null; resolve(); });
  });
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerTrackApiRoutes(httpServer: HttpServer, app: Express) {
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url === "/api/track-api/ws") {
      wss.handleUpgrade(req, socket as any, head, (ws) => {
        _clients.add(ws);
        // Send all existing entries as a snapshot so the UI populates immediately on connect
        if (_log.length > 0) {
          try { ws.send(JSON.stringify({ type: "snapshot", entries: _log })); } catch {}
        }
        ws.on("close", () => _clients.delete(ws));
      });
    }
  });

  app.get("/api/track-api/status", async (_req, res) => {
    const publicIp = await fetchPublicIp();
    const caCertPath = CA_CERT_PATH();
    res.json({
      running: !!_proxyServer,
      port: _proxyPort,
      mitm: _mitmEnabled,
      localIps: getLocalIps(),
      adapters: getLocalAdapters(),
      publicIp,
      entryCount: _log.length,
      caCertReady: fs.existsSync(caCertPath),
    });
  });

  app.post("/api/track-api/start", async (req, res) => {
    const port = Number(req.body?.port ?? 8899);
    const mitm = req.body?.mitm !== false;
    if (_proxyServer) { res.json({ ok: true, port: _proxyPort, mitm: _mitmEnabled }); return; }
    try {
      // Pre-generate CA cert eagerly so it's ready before first connection
      try { ensureCa(); } catch {}
      await startProxy(port, mitm);
      res.json({ ok: true, port, mitm });
    } catch (err: any) {
      res.status(500).json({ message: err.message ?? "Failed to start proxy" });
    }
  });

  app.post("/api/track-api/stop", async (_req, res) => {
    await stopProxy();
    res.json({ ok: true });
  });

  app.get("/api/track-api/logs", (_req, res) => {
    res.json({ entries: _log });
  });

  app.post("/api/track-api/clear", (_req, res) => {
    _log.length = 0;
    for (const ws of _clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "clear" }));
    }
    res.json({ ok: true });
  });

  // Download the CA certificate as a .crt file (for iPhone trust profile install)
  app.get("/api/track-api/ca-cert", (_req, res) => {
    try {
      ensureCa();
    } catch (err: any) {
      res.status(500).json({ message: "Failed to generate CA certificate" });
      return;
    }
    const certPath = CA_CERT_PATH();
    if (!fs.existsSync(certPath)) {
      res.status(404).json({ message: "CA cert not found" });
      return;
    }
    res.setHeader("Content-Type", "application/x-x509-ca-cert");
    res.setHeader("Content-Disposition", "attachment; filename=\"equinox-track-api-ca.crt\"");
    res.send(fs.readFileSync(certPath));
  });
}
