/**
 * tlsTransport.ts — CycleTLS-based HTTP transport for Instagram API calls.
 *
 * Replaces Node.js's OpenSSL TLS stack with a Go-based OkHttp4-compatible TLS
 * implementation. This makes every Instagram API request look like it was sent
 * from a real Android phone (Pixel 9 / Android 13) at the wire level:
 *  - JA3 fingerprint matches OkHttp 4.x (Android Instagram app)
 *  - Cipher suite order matches Android's TLS implementation
 *  - HTTP/2 SETTINGS frame matches Android OkHttp
 *
 * If CycleTLS fails to initialise (e.g. binary path issues in some Electron
 * build configurations), every function degrades gracefully to the original
 * Node.js HTTPS transport so nothing breaks.
 */

import { IgNetworkError } from "instagram-private-api";
import type { IgApiClient } from "instagram-private-api";

// ── OkHttp 4 / Android 13 JA3 fingerprint ────────────────────────────────────
// Cipher suites (decimal):
//   TLS_AES_128_GCM_SHA256 (4865), TLS_AES_256_GCM_SHA384 (4866),
//   TLS_CHACHA20_POLY1305_SHA256 (4867),
//   TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256 (49195),
//   TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256 (49199),
//   TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384 (49196),
//   TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384 (49200),
//   TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256 (52393),
//   TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256 (52392),
//   TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA (49171),
//   TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA (49172),
//   TLS_RSA_WITH_AES_128_GCM_SHA256 (156), TLS_RSA_WITH_AES_256_GCM_SHA384 (157),
//   TLS_RSA_WITH_AES_128_CBC_SHA (47), TLS_RSA_WITH_AES_256_CBC_SHA (53)
const OKHTTP4_JA3 =
  "771," +
  "4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53," +
  "0-23-65281-10-11-35-16-5-13-51-98-43-17513-27-21," +
  "29-23-24," +
  "0";

// ── Singleton CycleTLS client ─────────────────────────────────────────────────

type CycleTLSClient = {
  (url: string, options: Record<string, unknown>, method: string): Promise<{
    status: number;
    // CycleTLS v2.x changed the response field name from `.body` to `.data`.
    // `.data` holds the parsed body (JSON object) or the raw string, depending
    // on the responseType option.  `.body` no longer exists in v2.x.
    data: any;
    body?: never; // explicitly absent — do not read this
    headers: Record<string, string | string[]>;
  }>;
  exit(): void;
};

let _client: CycleTLSClient | null = null;
let _initPromise: Promise<CycleTLSClient | null> | null = null;
let _initFailed = false;

async function getClient(): Promise<CycleTLSClient | null> {
  if (_initFailed) return null;
  if (_client) return _client;
  if (_initPromise) return _initPromise;

  _initPromise = (async (): Promise<CycleTLSClient | null> => {
    try {
      const { default: initCycleTLS } = await import("cycletls");
      const client = await initCycleTLS();
      _client = client as unknown as CycleTLSClient;
      console.log("[tlsTrans] CycleTLS initialised — OkHttp4 JA3 fingerprint active");

      const cleanup = () => {
        try { (_client as any)?.exit(); } catch {}
      };
      process.once("exit", cleanup);
      process.once("SIGTERM", cleanup);
      process.once("SIGINT", cleanup);

      return _client;
    } catch (err: any) {
      console.warn(
        `[tlsTrans] CycleTLS init failed — falling back to Node.js TLS: ${err?.message ?? err}`,
      );
      _initFailed = true;
      return null;
    }
  })();

  return _initPromise;
}

/**
 * Call once at server startup to pre-warm the CycleTLS Go subprocess.
 * Without this the very first request pays the subprocess startup cost (~300 ms).
 */
export function warmupTls(): void {
  getClient().catch(() => {});
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function proxyHost(proxyUrl: string): string {
  try { return new URL(proxyUrl).hostname; } catch { return proxyUrl; }
}

function extractSetCookies(headers: Record<string, string | string[]>): string[] {
  const raw = headers["set-cookie"];
  const list: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((c) => c.split(";")[0]);
}

// ── tlsRequest ────────────────────────────────────────────────────────────────
/**
 * Drop-in replacement for the igReq() helper in instagramWebClient.ts.
 *
 * Routes through CycleTLS (OkHttp4 JA3) when available; falls back to
 * Node.js HTTPS via https-proxy-agent when CycleTLS is unavailable.
 *
 * IP-leak prevention is enforced: a missing proxyUrl always throws.
 */
export async function tlsRequest(opts: {
  host?: string;
  path: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  cookieJar?: string[];
  proxyUrl?: string;
}): Promise<{
  status: number;
  cookies: string[];
  json: any;
  rawBody: string;
  responseHeaders: Record<string, string | string[] | undefined>;
}> {
  const {
    host = "www.instagram.com",
    path,
    method,
    headers,
    body,
    cookieJar = [],
    proxyUrl,
  } = opts;

  // ── IP-LEAK PREVENTION ──────────────────────────────────────────────────────
  if (!proxyUrl) {
    throw new Error(
      `[IP-LEAK BLOCKED] TLS request ${method} ${path} refused — no proxy configured. ` +
      "Assign a proxy to this account before performing any actions.",
    );
  }

  const allHeaders: Record<string, string> = {
    ...headers,
    ...(cookieJar.length ? { Cookie: cookieJar.join("; ") } : {}),
    ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
  };

  const client = await getClient();

  // ── CycleTLS path (OkHttp4 JA3) ─────────────────────────────────────────────
  if (client) {
    const url = `https://${host}${path}`;
    const userAgent = allHeaders["User-Agent"] ?? "";
    // CycleTLS takes User-Agent as a dedicated field — remove from header map
    const { "User-Agent": _ua, ...headersWithoutUA } = allHeaders;

    const t0 = Date.now();
    let resp: { status: number; body: string; headers: Record<string, string | string[]> };
    try {
      resp = await client(
        url,
        {
          body: body ?? "",
          ja3: OKHTTP4_JA3,
          userAgent,
          headers: headersWithoutUA,
          proxy: proxyUrl,
          timeout: 30,
          disableRedirect: false,
          // Some proxy providers do SSL inspection (MITM) inside the CONNECT
          // tunnel — they present their own cert instead of Instagram's.
          // CycleTLS's Go binary verifies certs strictly by default, so it
          // rejects the proxy cert and returns status=0 with an empty body.
          // Node.js avoids this via NODE_TLS_REJECT_UNAUTHORIZED=0 in the
          // fallback path.  Setting insecureSkipVerify here gives the Go
          // binary the same leniency so it can route through MITM proxies.
          insecureSkipVerify: true,
        },
        method.toLowerCase(),
      );
    } catch (err: any) {
      const ph = proxyHost(proxyUrl);
      console.error(
        `[tls:req] ${method} ${host}${path} FAILED after ${Date.now() - t0}ms — proxy=${ph} err=${err?.message ?? err}`,
      );
      throw err;
    }

    const elapsed = Date.now() - t0;
    if (elapsed > 10000) {
      console.warn(
        `[tls:req] ${method} ${host}${path} SLOW ${elapsed}ms via proxy=${proxyHost(proxyUrl)} status=${resp.status}`,
      );
    }

    // Status 0 = CycleTLS got no HTTP response (proxy blocked the Go subprocess,
    // CONNECT tunnel rejected, or connection refused).  Fall through to the
    // Node.js HTTPS fallback so the request still has a chance of succeeding.
    //
    // NOTE: CycleTLS v2.x stores the response body in `.data`, NOT `.body`.
    // `.data` is an already-parsed JSON object (or a raw string) when the
    // request succeeds, or the Go error message string when status === 0.
    if (resp.status !== 0) {
      const cookies = extractSetCookies(resp.headers);
      const rawBody = typeof resp.data === "string"
        ? resp.data
        : (resp.data != null ? JSON.stringify(resp.data) : "");
      let json: any = null;
      try { json = JSON.parse(rawBody); } catch {
        // resp.data may already be a parsed object when responseType==="json"
        if (resp.data != null && typeof resp.data === "object") json = resp.data;
      }
      return { status: resp.status, cookies, json, rawBody, responseHeaders: resp.headers };
    }

    // Log the error the Go subprocess returned.  In CycleTLS v2.x the error
    // message (e.g. "proxyconnect tcp: EOF", "x509: certificate signed by
    // unknown authority") lives in resp.data (not resp.body which no longer exists).
    const cycleTlsErr = resp.data != null
      ? (typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data))
      : "";
    console.warn(
      `[tls:req] CycleTLS returned status 0 for ${method} ${host}${path}` +
      ` elapsed=${elapsed}ms proxy=${proxyHost(proxyUrl)}` +
      ` err=${cycleTlsErr.slice(0, 300) || "(empty)"}` +
      ` — retrying via Node.js HTTPS`,
    );
  }

  // ── Node.js TLS fallback ──────────────────────────────────────────────────
  // Reached when: (a) CycleTLS never initialised, or (b) CycleTLS returned
  // status 0 (proxy blocked the Go subprocess connection).
  if (client) {
    console.warn(`[tls:req] CycleTLS→Node.js fallback for ${method} ${host}${path}`);
  } else {
    console.warn(`[tls:req] CycleTLS unavailable — using Node.js TLS for ${method} ${host}${path}`);
  }
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  const https = await import("node:https");
  const zlib = await import("node:zlib");

  const agent = new HttpsProxyAgent(proxyUrl, { keepAlive: false });
  const t0 = Date.now();
  try {
    const res = await new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }>((resolve, reject) => {
      const req = https.request(
        { host, port: 443, path, method, headers: allHeaders, agent },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (chunk: Buffer) => chunks.push(chunk));
          r.on("end", () => {
            let raw = Buffer.concat(chunks);
            const enc = r.headers["content-encoding"];
            try {
              if (enc === "gzip") raw = zlib.gunzipSync(raw);
              else if (enc === "deflate") raw = zlib.inflateSync(raw);
              else if (enc === "br") raw = zlib.brotliDecompressSync(raw);
            } catch {}
            resolve({ status: r.statusCode ?? 0, headers: r.headers as any, body: raw.toString("utf8") });
          });
          r.on("error", reject);
        },
      );
      req.on("error", reject);
      req.setTimeout(25000, () => req.destroy(new Error("request_timeout")));
      if (body) req.write(body);
      req.end();
    });

    const elapsed = Date.now() - t0;
    if (elapsed > 10000) {
      console.warn(
        `[tls:fallback] ${method} ${host}${path} SLOW ${elapsed}ms via proxy=${proxyHost(proxyUrl)} status=${res.status}`,
      );
    }

    const rawSC = res.headers["set-cookie"];
    const cookies = (Array.isArray(rawSC) ? rawSC : rawSC ? [rawSC] : []).map((c: string) => c.split(";")[0]);
    let json: any = null;
    try { json = JSON.parse(res.body); } catch {}

    return { status: res.status, cookies, json, rawBody: res.body, responseHeaders: res.headers };
  } catch (err: any) {
    const ph = proxyHost(proxyUrl);
    console.error(
      `[tls:fallback] ${method} ${host}${path} FAILED after ${Date.now() - t0}ms — proxy=${ph} code=${err?.code ?? "?"} msg=${err?.message ?? err}`,
    );
    throw err;
  } finally {
    agent.destroy();
  }
}

// ── patchIgClientTls ──────────────────────────────────────────────────────────
/**
 * Patches a freshly-created IgApiClient instance so that all outbound HTTP
 * calls it makes go through CycleTLS (OkHttp4 JA3) instead of Node.js's
 * OpenSSL TLS stack.
 *
 * How it works:
 *  - Replaces ig.request.faultTolerantRequest (the innermost HTTP dispatch
 *    method) with a CycleTLS-backed version.
 *  - By the time faultTolerantRequest is called, the library has already
 *    assembled the full request: headers (User-Agent, X-IG-*, cookies), URL,
 *    proxy, and body. We just swap the wire transport.
 *  - After the response, Set-Cookie headers are written back to the library's
 *    tough-cookie jar so session state is maintained correctly.
 *  - Falls back transparently to the original transport if CycleTLS is
 *    unavailable (e.g. binary not found in some Electron distributions).
 *
 * Call immediately after `ig.state.proxyUrl = proxyUrl` and before any
 * ig.request.* call.  If proxyUrl is undefined we skip patching (callers
 * without a proxy are already blocked elsewhere).
 */
export function patchIgClientTls(ig: IgApiClient, proxyUrl: string | undefined): void {
  if (!proxyUrl) return;

  const _reqObj = ig.request as any;
  const _origFTR = _reqObj.faultTolerantRequest.bind(_reqObj);

  _reqObj.faultTolerantRequest = async function (options: any) {
    const client = await getClient();
    if (!client) {
      // CycleTLS unavailable — delegate to original (Node.js TLS) transport
      return _origFTR(options);
    }

    // ── Resolve full URL ──────────────────────────────────────────────────────
    const baseUrl: string = options.baseUrl ?? "https://i.instagram.com/";
    const rawUrl: string = options.url ?? options.uri ?? "";
    let fullUrl: string;
    try {
      fullUrl = rawUrl.startsWith("http") ? rawUrl : new URL(rawUrl, baseUrl).toString();
    } catch {
      fullUrl = baseUrl.replace(/\/$/, "") + rawUrl;
    }

    // Append query string parameters
    if (options.qs && typeof options.qs === "object" && Object.keys(options.qs).length > 0) {
      const params = new URLSearchParams(
        Object.entries(options.qs as Record<string, any>)
          .filter(([, v]) => v != null)
          .map(([k, v]) => [k, String(v)]),
      );
      fullUrl += (fullUrl.includes("?") ? "&" : "?") + params.toString();
    }

    // ── Read cookies from the request-promise cookie jar (tough-cookie) ───────
    let cookieStr = "";
    if (options.jar) {
      try {
        // request-promise wraps tough-cookie; inner jar is at ._jar
        const innerJar = options.jar["_jar"];
        if (innerJar?.getCookiesSync) {
          cookieStr = (innerJar.getCookiesSync(fullUrl) as any[])
            .map((c: any) => `${c.key}=${c.value}`)
            .join("; ");
        } else if (typeof options.jar.getCookieString === "function") {
          cookieStr = (options.jar.getCookieString(fullUrl) as string) ?? "";
        }
      } catch {}
    }

    // ── Build headers — filter undefined values ───────────────────────────────
    const headers: Record<string, string> = {};
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers as Record<string, any>)) {
        if (v != null) headers[k] = String(v);
      }
    }
    if (cookieStr) headers["Cookie"] = cookieStr;

    // ── Build request body ────────────────────────────────────────────────────
    const method = (options.method ?? "GET").toUpperCase();
    let body = "";
    if (method !== "GET" && options.form && typeof options.form === "object") {
      const params = new URLSearchParams(
        Object.entries(options.form as Record<string, any>)
          .filter(([, v]) => v != null)
          .map(([k, v]) => [k, String(v)]),
      );
      body = params.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    } else if (options.body) {
      body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }

    // CycleTLS takes User-Agent as a dedicated field
    const userAgent = headers["User-Agent"] ?? "";
    const { "User-Agent": _ua, ...headersWithoutUA } = headers;

    const t0 = Date.now();
    let resp: { status: number; body: string; headers: Record<string, string | string[]> };
    try {
      resp = await client(
        fullUrl,
        {
          body,
          ja3: OKHTTP4_JA3,
          userAgent,
          headers: headersWithoutUA,
          proxy: proxyUrl,
          timeout: 30,
          disableRedirect: false,
        },
        method.toLowerCase(),
      );
    } catch (err: any) {
      console.error(
        `[tls:ig] ${method} ${rawUrl} FAILED after ${Date.now() - t0}ms — err=${err?.message ?? err}`,
      );
      throw new IgNetworkError(err);
    }

    if (Date.now() - t0 > 10000) {
      console.warn(`[tls:ig] ${method} ${rawUrl} SLOW ${Date.now() - t0}ms status=${resp.status}`);
    }

    // ── Write Set-Cookie back to the library's tough-cookie jar ──────────────
    if (options.jar) {
      try {
        const innerJar = options.jar["_jar"];
        const rawSetCookie = resp.headers["set-cookie"];
        const setCookies = Array.isArray(rawSetCookie) ? rawSetCookie : rawSetCookie ? [rawSetCookie] : [];
        if (innerJar?.setCookieSync) {
          for (const cs of setCookies) {
            try { innerJar.setCookieSync(cs, fullUrl, {}); } catch {}
          }
        }
      } catch {}
    }

    // ── Parse response body ───────────────────────────────────────────────────
    // CycleTLS v2.x: body is in .data (already-parsed JSON or raw string).
    const rawBody = typeof resp.data === "string"
      ? resp.data
      : (resp.data != null ? JSON.stringify(resp.data) : "");
    // .data may already be a parsed object when responseType==="json"
    let parsedBody: any = (resp.data != null && typeof resp.data === "object")
      ? resp.data
      : rawBody;
    if (typeof parsedBody === "string") {
      try { parsedBody = JSON.parse(parsedBody); } catch {}
    }

    // ── Return synthetic response in the shape instagram-private-api expects ──
    // The library's Request.send() reads:
    //   response.statusCode, response.headers, response.body (parsed JSON),
    //   response.request.method, response.request.uri.path (for error messages)
    return {
      statusCode: resp.status,
      headers: resp.headers,
      body: parsedBody,
      request: {
        method,
        uri: {
          path: (() => {
            try {
              const u = new URL(fullUrl);
              return u.pathname + u.search;
            } catch {
              return rawUrl;
            }
          })(),
        },
      },
    };
  };
}

/**
 * Patches the mobilePostMultipart helper's raw httpsRequest call to use
 * CycleTLS. Unlike igReq / IgApiClient, this function assembles and fires a
 * raw multipart POST. Pass the headers/body/proxyUrl already assembled by
 * the caller; returns the parsed JSON body or null.
 */
export async function tlsMultipartPost(
  host: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer,
  proxyUrl: string | undefined,
): Promise<any> {
  if (!proxyUrl) {
    throw new Error(
      `[IP-LEAK BLOCKED] TLS multipart POST ${host}${path} refused — no proxy configured.`,
    );
  }

  const client = await getClient();

  if (client) {
    const url = `https://${host}${path}`;
    const userAgent = headers["User-Agent"] ?? "";
    const { "User-Agent": _ua, ...headersWithoutUA } = headers;

    try {
      const resp = await client(
        url,
        {
          body: body.toString("binary"),
          ja3: OKHTTP4_JA3,
          userAgent,
          headers: headersWithoutUA,
          proxy: proxyUrl,
          timeout: 60,
          disableRedirect: false,
        },
        "post",
      );
      const rawBody = typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body);
      let json: any = null;
      try { json = JSON.parse(rawBody); } catch {}
      return json;
    } catch (err: any) {
      console.error(`[tls:multipart] POST ${host}${path} FAILED — err=${err?.message ?? err}`);
      throw err;
    }
  }

  // Fallback: Node.js HTTPS
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  const https = await import("node:https");
  const agent = new HttpsProxyAgent(proxyUrl, { keepAlive: false });
  try {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = https.request(
        { host, port: 443, path, method: "POST", headers, agent },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (chunk: Buffer) => chunks.push(chunk));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          r.on("error", reject);
        },
      );
      req.on("error", reject);
      req.setTimeout(60000, () => req.destroy(new Error("request_timeout")));
      req.write(body);
      req.end();
    });
    let json: any = null;
    try { json = JSON.parse(res.body); } catch {}
    return json;
  } finally {
    agent.destroy();
  }
}
