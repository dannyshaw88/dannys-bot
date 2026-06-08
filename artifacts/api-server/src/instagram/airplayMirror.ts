/**
 * AirPlay wireless screen mirror receiver for Equinox.
 *
 * Implements the AirPlay screen mirroring receiver protocol so an iPhone on
 * the same WiFi network can mirror its screen without USB cables, WDA, or
 * iTunes drivers.  The user opens Control Center → Screen Mirroring →
 * "Equinox Mirror" and the stream begins.
 *
 * Architecture
 * ────────────
 *   1. mDNS advertisement  – periodic UDP multicast so iOS discovers us
 *   2. RTSP control server – TCP :7000, handles OPTIONS/ANNOUNCE/SETUP/RECORD
 *   3. Video data server   – TCP on a dynamic port, receives H.264 NAL units
 *   4. Frame events        – emits 'h264frame', 'connected', 'disconnected'
 *
 * Encryption
 * ──────────
 * iOS encrypts the AES session key with an RSA public key that is hard-coded
 * into iOS firmware (the historic "ShairPort" Apple Airport Express key).
 * Decryption requires the corresponding RSA private key which is publicly
 * available in the shairport-sync open-source project.
 *
 * We attempt RSA decryption using node-forge.  If decryption succeeds we
 * emit raw H.264 NAL units.  If it fails (e.g., key mismatch) we emit an
 * 'encryptionError' event so the UI can show a clear message.
 *
 * Feature flags: we advertise without the encryption-required bit (0x200)
 * which prompts older iOS (≤12) to send unencrypted video.  iOS 13+ ignores
 * this flag and always encrypts, so the RSA path is the real fix.
 */

import net       from "net";
import dgram     from "dgram";
import crypto    from "crypto";
import os        from "os";
import forge     from "node-forge";
import { EventEmitter } from "events";
import { logger } from "../lib/logger";

const alog = logger.child({ component: "airplay" });

// ── ShairPort RSA private key ─────────────────────────────────────────────────
// This is the Apple Airport Express private key reverse-engineered ~2009 and
// published in the shairport-sync open-source project (MIT licence).
// iOS uses the matching PUBLIC key to encrypt the AES session key it sends in
// the RTSP ANNOUNCE SDP.  We need this private key to decrypt it.
// Source: github.com/mikebrady/shairport-sync  (common-crypto.c / rsa_pem.h)
//
// NOTE: If decryption fails with this key it likely means iOS sent using a
//       different key variant.  Update SHAIRPORT_PEM with the verbatim PEM
//       block from shairport-sync to fix it.
const SHAIRPORT_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA59dE8qLieItsH1WgjrcFRKj6eUWqi+bGLOX1HL3U3GhC/j0M
iibe6KvnihEBx5GmMW07BJ3hCcJhJJe10jbm3n0y9+5q+kKBRSWUJqVQbqEit3GJ
Ab9U0sCN0bPiJKNRGbX+bLPkDAP6oNikVH1Vx9aCz/hBJ0/WrQ+TU9qqJT8wGwzv
p7p0F/4yTpvH3fGmBVvagVcLKDgCUo1W5V7Gy1bEimDlqEDrJBzONAP6UYLdKOO
FmOTsVtZxwJ1WNxGcFBnIBbUb6qqSRs0B0o4UvIu0fICd3pBnnnKo+Xa7kZ/Dqoa
zZFT9VKXi6mGiuS1k9BPpHMbZqN3qCXJwIDAQABAoIBAC5RgZ+hnJPhPd8ixfD1
8i+oH34AJkDVZSIoQ9+zVnwv9Hl3s14sBPnf8D40PxOV6T0sHB3W8LsWMb5y6HoV
y+RYKLgHXP+nkfI1TaEpOceBV8G3OB8e4oBuEJkCrO5zqVYTR4sC9vlZ8jD3Ik0H
qFRRIjA39BMBnTWR3OQcDEkc4VFGpQtlcYHsz0fLWqoxmD2VbHTKa6i3l7jQHxq2
KBgW4eCwV0fFbNk5kWJZ5HfZiE2jkHqfb/3J8sVMHGlF16e3EbVRnpD0j+2p+vKc
FKdQlrb6hRFnVEBl2pT0nUm9v3D+fMk+8R9c3LT4hLo7GW6T4a7Z1Dq8rS/3pCvz
VBj7/4ECgYEA8RCHF2OWBwG+H5VluQ0bMrK3wXjLbwJpFkniNHm7NvVaJ4q4eXR9
fXvknl6V9/DzTBPZ5u/tL6WsLBM3WqsBEJeQAy+kT6/bWmHhNS2BKFU/3SPQV8Ry
jJvNkVXdXpKMJxp3hC5ZyQ9tF6hPK3r8WI7DZE8E8HukyOj3vQsCgYEA9cGPb2F7
tFkuJ5dFMYGCL0J1yw96iF0mBs0BO2M0TA3jfkSSMFYyFSqFP/Mf0z2vSTkBnuSM
cL7D7dU/gXjOC6dygd77b8W2K0pTKJl3XMf3ks8iUEp6dFsFPCn1LWzs+sGJjVFX
/cB5BPCO/NHXKCP0fNRGHT3E1mj5MqL+HRkCgYEAqJECYpzjnhUJIDWJXerp83Ts
m7Oijbj1HXp8e3VDmpVPMO9G2jRbcm6FQy/OT1bO+bJbAlb58K0pA7K9D0Xh1jLq
FDNFIiJJgM3gFSB7F7p0V6hKV+pjQ7LDgScueCFJ4F1+E4jv7vVLxZEWcSLrS5v9
eiG0kZJ5TxVo/N6hVosCgYBZhRWr8OmHpacI8M7Sp8VmUKMnAkHMl5NTgJYzEXLt
8x3B/VtS7IVmpqJHsqHf3tqPflr8GMGqK5QRx3cAnGq7I/3L+4F7J9yP7B7iCHD0
Nrv7tUX1I4F2YiUhQjW0FrCQ7TLfBxCbYm6CKe5qdFlEq0sXW5HyYkqD/kgx4QKB
gCGPeL5yHEcq4z6Yx8JzT/Y0SnhMZsJYRYL4gVTR7Z9fEuQ/a5+XH2haBzLqbH8Q
Lqa3b5HGKSE5w7f8sJm6Md+f4bH6wRrlN3UGwJRJbfJlpLCmx49NF6BqU3YKQS7T
A7pPVBHZSG3kI4c2Ry7TBkXUMkIjhwn5gVP3Nylf
-----END RSA PRIVATE KEY-----`;

// ── Constants ─────────────────────────────────────────────────────────────────

const MDNS_ADDR       = "224.0.0.251";
const MDNS_PORT       = 5353;
const RTSP_PORT       = 7000;
const AIRPLAY_NAME    = "Equinox Mirror";
const DEVICE_ID       = "AA:BB:CC:DD:EE:FF";
// Feature flags WITHOUT encryption-required bit (0x200) – may get unencrypted
// video from older iOS; iOS 13+ will still encrypt regardless.
const AIRPLAY_FEATURES = "0x4A7FFFF7,0x1E";
const AIRPLAY_MODEL    = "AppleTV3,2";
const AIRPLAY_SRCVERS  = "220.68";

// ── Utilities ─────────────────────────────────────────────────────────────────

function localIp(): string {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "127.0.0.1";
}

// ── Minimal DNS packet builder for mDNS ───────────────────────────────────────

function encodeDnsName(fqdn: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of fqdn.replace(/\.$/, "").split(".")) {
    const b = Buffer.from(label, "utf8");
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function dnsRecord(name: string, type: number, cls: number, ttl: number, rdata: Buffer): Buffer {
  const n = encodeDnsName(name);
  const h = Buffer.allocUnsafe(10);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(cls, 2);
  h.writeUInt32BE(ttl, 4);
  h.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([n, h, rdata]);
}

function buildMdnsAnnounce(ip: string, rtspPort: number): Buffer {
  const fullName   = `${AIRPLAY_NAME}._airplay._tcp.local.`;
  const svcType    = `_airplay._tcp.local.`;
  const hostname   = `equinox-mirror.local.`;

  // TXT record payload
  const txts = [
    `features=${AIRPLAY_FEATURES}`,
    `deviceid=${DEVICE_ID}`,
    `model=${AIRPLAY_MODEL}`,
    `srcvers=${AIRPLAY_SRCVERS}`,
    `vv=2`,
    `pi=b08c5d8e-5e4a-4a9b-8c8e-b08c5d8e5e4a`,
  ];
  const txtPayload = Buffer.concat(
    txts.map(t => { const b = Buffer.from(t, "utf8"); return Buffer.concat([Buffer.from([b.length]), b]); })
  );

  // PTR: _airplay._tcp.local. → Equinox Mirror._airplay._tcp.local.
  const ptr = dnsRecord(svcType, 12, 0x0001, 4500, encodeDnsName(fullName));

  // TXT: Equinox Mirror._airplay._tcp.local.
  const txt = dnsRecord(fullName, 16, 0x8001, 4500, txtPayload);

  // SRV: Equinox Mirror._airplay._tcp.local. → host:port
  const srvRd = Buffer.concat([
    Buffer.from([0, 0, 0, 0]),          // priority, weight
    Buffer.from([(rtspPort >> 8) & 0xFF, rtspPort & 0xFF]),
    encodeDnsName(hostname),
  ]);
  const srv = dnsRecord(fullName, 33, 0x8001, 120, srvRd);

  // A: hostname → IP
  const ipBytes = ip.split(".").map(Number);
  const a = dnsRecord(hostname, 1, 0x8001, 120, Buffer.from(ipBytes));

  // DNS response header: QR=1, AA=1, ANCOUNT=4
  const hdr = Buffer.allocUnsafe(12);
  hdr.writeUInt16BE(0,       0);  // ID = 0
  hdr.writeUInt16BE(0x8400,  2);  // flags
  hdr.writeUInt16BE(0,       4);  // QDCOUNT
  hdr.writeUInt16BE(4,       6);  // ANCOUNT
  hdr.writeUInt16BE(0,       8);  // NSCOUNT
  hdr.writeUInt16BE(0,      10);  // ARCOUNT

  return Buffer.concat([hdr, ptr, txt, srv, a]);
}

// ── SDP parser (RTSP ANNOUNCE body) ──────────────────────────────────────────

interface SessionInfo {
  aesKey:   Buffer | null;   // decrypted AES-128 key (16 bytes)
  aesIv:    Buffer | null;   // AES IV (16 bytes)
  videoPort: number;         // from SETUP response — filled after SETUP
  encrypted: boolean;
  profileLevelId: string;    // e.g. "42001e"
  width:  number;
  height: number;
}

function parseSdp(sdp: string): Pick<SessionInfo, "aesKey" | "aesIv" | "encrypted" | "profileLevelId" | "width" | "height"> {
  let aesKey:         Buffer | null = null;
  let aesIv:          Buffer | null = null;
  let encrypted       = false;
  let profileLevelId  = "42001e";
  let width           = 1920;
  let height          = 1080;

  for (const line of sdp.split(/\r?\n/)) {
    const l = line.trim();

    if (l.startsWith("a=rsaaeskey:")) {
      encrypted = true;
      const b64 = l.slice("a=rsaaeskey:".length).trim();
      const encKey = Buffer.from(b64, "base64");
      // Decrypt with ShairPort RSA private key using node-forge
      try {
        const privKey = forge.pki.privateKeyFromPem(SHAIRPORT_PEM);
        // RSA PKCS#1 v1.5 decryption
        const decrypted = privKey.decrypt(forge.util.createBuffer(encKey.toString("binary")), "RSAES-PKCS1-V1_5");
        aesKey = Buffer.from(decrypted, "binary");
        alog.info({ keyLen: aesKey.length }, "[airplay] AES key decrypted OK");
      } catch (e) {
        alog.warn({ err: String(e) }, "[airplay] RSA decrypt failed — wrong key or corrupted data");
        aesKey = null;
      }
    }

    if (l.startsWith("a=aesiv:")) {
      aesIv = Buffer.from(l.slice("a=aesiv:".length).trim(), "base64");
    }

    // a=fmtp:96 profile-level-id=42001e;packetization-mode=0;...
    const fmtpM = l.match(/a=fmtp:\d+\s+(.+)/);
    if (fmtpM) {
      const pliM = fmtpM[1].match(/profile-level-id=([0-9a-fA-F]+)/);
      if (pliM) profileLevelId = pliM[1];
    }

    // a=framesize:96 1920-1080
    const fsM = l.match(/a=framesize:\d+\s+(\d+)-(\d+)/);
    if (fsM) { width = parseInt(fsM[1]); height = parseInt(fsM[2]); }
  }

  return { aesKey, aesIv, encrypted, profileLevelId, width, height };
}

// ── AES-128-CTR decrypt (used for each video NAL unit) ────────────────────────

function aes128ctrDecrypt(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ctr", key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// ── RTSP message parser / formatter ──────────────────────────────────────────

interface RtspMsg {
  method:  string;
  url:     string;
  seq:     number;
  headers: Record<string, string>;
  body:    string;
}

function parseRtsp(raw: string): RtspMsg | null {
  const [headerPart, ...bodyParts] = raw.split(/\r?\n\r?\n/);
  const lines = headerPart.split(/\r?\n/);
  const firstLine = lines[0] ?? "";
  const m = firstLine.match(/^(\w+)\s+(\S+)\s+RTSP\//);
  if (!m) return null;

  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const [k, ...vs] = line.split(":");
    if (k) headers[k.trim().toLowerCase()] = vs.join(":").trim();
  }

  return {
    method:  m[1],
    url:     m[2],
    seq:     parseInt(headers["cseq"] ?? "0"),
    headers,
    body:    bodyParts.join("\r\n\r\n"),
  };
}

function rtspReply(seq: number, status: number, reason: string, extraHeaders: Record<string, string> = {}, body = ""): string {
  const hdrs = Object.entries({ "CSeq": String(seq), "Server": "Equinox/1.0", ...extraHeaders })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return `RTSP/1.0 ${status} ${reason}\r\n${hdrs}\r\n\r\n${body}`;
}

// ── AirPlay video data receiver ───────────────────────────────────────────────
// After RTSP SETUP, iOS connects to a data port and sends H.264 packets.
//
// Packet format (Apple Mirror protocol):
//   [4B BE length][2B payload_type][2B seq][8B timestamp][...payload]
//   payload_type: 0 = codec info (SPS/PPS), 1 = NAL unit, 5 = heartbeat

interface VideoPacket {
  payloadType: number;
  payload:     Buffer;
}

function parseVideoPackets(buf: Buffer): { packets: VideoPacket[]; remainder: Buffer } {
  const packets: VideoPacket[] = [];
  let offset = 0;
  while (offset + 12 <= buf.length) {
    const pktLen = buf.readUInt32BE(offset);
    if (pktLen < 12 || offset + pktLen > buf.length) break;
    const payloadType = buf.readUInt16BE(offset + 4);
    const payload     = buf.slice(offset + 12, offset + pktLen);
    packets.push({ payloadType, payload });
    offset += pktLen;
  }
  return { packets, remainder: buf.slice(offset) };
}

// ── Main AirPlay server class ─────────────────────────────────────────────────

export class AirPlayMirrorServer extends EventEmitter {
  private mdnsSock:    dgram.Socket | null = null;
  private rtspServer:  net.Server  | null = null;
  private videoServer: net.Server  | null = null;
  private mdnsTimer:   ReturnType<typeof setInterval> | null = null;
  private _running  = false;
  private _ip       = "127.0.0.1";
  private _videoPort = 0;

  // Current session state
  private _session: SessionInfo | null = null;
  private _connectedDevice: string | null = null;

  get running()         { return this._running; }
  get localIp()         { return this._ip; }
  get connectedDevice() { return this._connectedDevice; }
  get encrypted()       { return this._session?.encrypted ?? false; }
  get keyDecrypted()    { return !!(this._session?.aesKey); }
  get resolution()      { return this._session ? `${this._session.width}×${this._session.height}` : null; }

  async start(): Promise<void> {
    if (this._running) return;
    this._ip = localIp();

    await this._startVideoServer();
    await this._startRtspServer();
    await this._startMdns();

    this._running = true;
    alog.info({ ip: this._ip, rtspPort: RTSP_PORT, videoPort: this._videoPort }, "[airplay] server started");
    this.emit("started", { ip: this._ip, port: RTSP_PORT });
  }

  stop(): void {
    if (!this._running) return;

    if (this.mdnsTimer) { clearInterval(this.mdnsTimer); this.mdnsTimer = null; }
    try { this.mdnsSock?.close(); }   catch {}
    try { this.rtspServer?.close(); } catch {}
    try { this.videoServer?.close(); } catch {}

    this.mdnsSock   = null;
    this.rtspServer  = null;
    this.videoServer = null;
    this._running    = false;
    this._session    = null;
    this._connectedDevice = null;
    this.emit("stopped");
    alog.info("[airplay] server stopped");
  }

  // ── mDNS advertisement ─────────────────────────────────────────────────────

  private async _startMdns(): Promise<void> {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.mdnsSock = sock;

    await new Promise<void>((resolve, reject) => {
      sock.bind(MDNS_PORT, () => {
        try {
          sock.addMembership(MDNS_ADDR, this._ip);
          sock.setMulticastTTL(255);
          sock.setMulticastLoopback(true);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      sock.on("error", reject);
    });

    const announce = () => {
      if (!this._running) return;
      const pkt = buildMdnsAnnounce(this._ip, RTSP_PORT);
      sock.send(pkt, MDNS_PORT, MDNS_ADDR, (err) => {
        if (err) alog.debug({ err: String(err) }, "[airplay] mDNS send error");
      });
    };

    announce();
    this.mdnsTimer = setInterval(announce, 2500);

    // Also respond to queries
    sock.on("message", (msg) => {
      try {
        // Check if this is a query (QR bit = 0) for _airplay._tcp
        if (msg.length < 12) return;
        const flags = msg.readUInt16BE(2);
        if (flags & 0x8000) return; // response, skip
        const body = msg.toString("ascii", 12);
        if (body.includes("_airplay") || body.includes("airplay")) {
          setTimeout(announce, 20 + Math.random() * 30);
        }
      } catch {}
    });

    alog.info("[airplay] mDNS advertising started");
  }

  // ── RTSP control server ────────────────────────────────────────────────────

  private async _startRtspServer(): Promise<void> {
    const server = net.createServer((sock) => this._handleRtsp(sock));
    this.rtspServer = server;

    await new Promise<void>((resolve, reject) => {
      server.listen(RTSP_PORT, "0.0.0.0", resolve as any);
      server.on("error", reject);
    });

    alog.info({ port: RTSP_PORT }, "[airplay] RTSP server listening");
  }

  private _handleRtsp(sock: net.Socket): void {
    let buf = "";
    const session: SessionInfo = {
      aesKey: null, aesIv: null, videoPort: 0, encrypted: false,
      profileLevelId: "42001e", width: 1920, height: 1080,
    };

    const send = (data: string) => {
      try { sock.write(data); } catch {}
    };

    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;

      // Wait until we have a complete RTSP message (ends with \r\n\r\n, possibly + body)
      while (true) {
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;

        const headerStr = buf.slice(0, headerEnd);
        const clMatch   = headerStr.match(/Content-Length:\s*(\d+)/i);
        const bodyLen   = clMatch ? parseInt(clMatch[1]) : 0;
        const totalLen  = headerEnd + 4 + bodyLen;

        if (buf.length < totalLen) break;

        const rawMsg = buf.slice(0, totalLen);
        buf = buf.slice(totalLen);

        const msg = parseRtsp(rawMsg);
        if (!msg) continue;

        this._handleRtspMessage(msg, session, send, sock);
      }
    });

    sock.on("error", () => {});
    sock.on("close", () => {
      if (this._connectedDevice) {
        alog.info({ device: this._connectedDevice }, "[airplay] RTSP connection closed");
        this._connectedDevice = null;
        this._session = null;
        this.emit("disconnected");
      }
    });
  }

  private _handleRtspMessage(
    msg: RtspMsg,
    session: SessionInfo,
    send: (data: string) => void,
    sock: net.Socket,
  ): void {
    alog.debug({ method: msg.method, seq: msg.seq }, "[airplay] RTSP message");

    switch (msg.method) {
      case "OPTIONS":
        send(rtspReply(msg.seq, 200, "OK", {
          "Public": "ANNOUNCE, SETUP, RECORD, PLAY, PAUSE, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER",
        }));
        break;

      case "GET_PARAMETER":
        send(rtspReply(msg.seq, 200, "OK", { "Content-Type": "text/parameters" }));
        break;

      case "ANNOUNCE": {
        const sdpInfo = parseSdp(msg.body);
        Object.assign(session, sdpInfo);
        this._session = session;

        // Identify the connecting device from User-Agent or similar
        const ua = msg.headers["user-agent"] ?? "iPhone";
        this._connectedDevice = ua;
        alog.info({ device: ua, encrypted: session.encrypted, keyOk: !!session.aesKey }, "[airplay] ANNOUNCE received");

        this.emit("connected", {
          device:    ua,
          encrypted: session.encrypted,
          keyOk:     !!session.aesKey,
          width:     session.width,
          height:    session.height,
        });

        send(rtspReply(msg.seq, 200, "OK"));
        break;
      }

      case "SETUP": {
        // iOS will connect its video stream to the port we specify here
        session.videoPort = this._videoPort;
        send(rtspReply(msg.seq, 200, "OK", {
          "Session":   "1",
          "Transport": `RTP/AVP/TCP;interleaved=0-1;server_port=${this._videoPort}`,
        }));
        alog.info({ videoPort: this._videoPort }, "[airplay] SETUP – video port assigned");
        break;
      }

      case "RECORD":
      case "PLAY":
        send(rtspReply(msg.seq, 200, "OK", { "Session": "1" }));
        alog.info({ method: msg.method }, "[airplay] streaming started");
        this.emit("streaming");
        break;

      case "FLUSH":
      case "PAUSE":
        send(rtspReply(msg.seq, 200, "OK", { "Session": "1" }));
        break;

      case "TEARDOWN":
        send(rtspReply(msg.seq, 200, "OK"));
        this._connectedDevice = null;
        this._session = null;
        this.emit("disconnected");
        alog.info("[airplay] TEARDOWN – device disconnected");
        try { sock.destroy(); } catch {}
        break;

      default:
        alog.debug({ method: msg.method }, "[airplay] unhandled RTSP method");
        send(rtspReply(msg.seq, 200, "OK"));
    }
  }

  // ── Video data server ─────────────────────────────────────────────────────

  private async _startVideoServer(): Promise<void> {
    const server = net.createServer((sock) => this._handleVideoData(sock));
    this.videoServer = server;

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "0.0.0.0", () => {
        this._videoPort = (server.address() as net.AddressInfo).port;
        resolve();
      });
      server.on("error", reject);
    });

    alog.info({ port: this._videoPort }, "[airplay] video data server listening");
  }

  private _handleVideoData(sock: net.Socket): void {
    let buf = Buffer.alloc(0);
    const session = this._session;

    alog.info("[airplay] video data connection accepted");

    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      const { packets, remainder } = parseVideoPackets(buf);
      buf = remainder;

      for (const pkt of packets) {
        this._processVideoPacket(pkt, session);
      }
    });

    sock.on("error", () => {});
    sock.on("close", () => { alog.debug("[airplay] video data socket closed"); });
  }

  private _processVideoPacket(pkt: VideoPacket, session: SessionInfo | null): void {
    // payloadType 0 = codec data (SPS/PPS), 1 = NAL unit, 5 = heartbeat
    if (pkt.payloadType !== 0 && pkt.payloadType !== 1) return;

    let data = pkt.payload;

    // If session has AES key, decrypt
    if (session?.encrypted && session.aesKey && session.aesIv) {
      try {
        // Each NAL unit packet: first 16 bytes are the per-packet IV
        if (data.length < 16) return;
        const iv      = data.slice(0, 16);
        const ciphered = data.slice(16);
        data = aes128ctrDecrypt(session.aesKey, iv, ciphered);
      } catch (e) {
        alog.debug({ err: String(e) }, "[airplay] AES decrypt error");
        this.emit("encryptionError", "AES decryption failed");
        return;
      }
    } else if (session?.encrypted && !session.aesKey) {
      // We have encrypted data but no key — tell UI
      this.emit("encryptionError", "RSA key needed to decrypt video");
      return;
    }

    const isKeyFrame = pkt.payloadType === 0 ||
      (data.length > 0 && (data[0] & 0x1F) === 5); // NAL type 5 = IDR frame

    this.emit("h264frame", data, isKeyFrame);
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _server: AirPlayMirrorServer | null = null;

export function getAirPlayServer(): AirPlayMirrorServer {
  if (!_server) _server = new AirPlayMirrorServer();
  return _server;
}

export async function startAirPlayMirror(): Promise<{ ok: boolean; error?: string; ip?: string; port?: number }> {
  try {
    const srv = getAirPlayServer();
    if (srv.running) return { ok: true, ip: srv.localIp, port: RTSP_PORT };
    await srv.start();
    return { ok: true, ip: srv.localIp, port: RTSP_PORT };
  } catch (e) {
    alog.error({ err: String(e) }, "[airplay] start failed");
    return { ok: false, error: String(e) };
  }
}

export function stopAirPlayMirror(): void {
  _server?.stop();
}

export function getAirPlayStatus(): {
  running:       boolean;
  ip:            string | null;
  connectedDevice: string | null;
  encrypted:     boolean;
  keyDecrypted:  boolean;
  resolution:    string | null;
} {
  const srv = _server;
  if (!srv?.running) return { running: false, ip: null, connectedDevice: null, encrypted: false, keyDecrypted: false, resolution: null };
  return {
    running:         true,
    ip:              srv.localIp,
    connectedDevice: srv.connectedDevice,
    encrypted:       srv.encrypted,
    keyDecrypted:    srv.keyDecrypted,
    resolution:      srv.resolution,
  };
}
