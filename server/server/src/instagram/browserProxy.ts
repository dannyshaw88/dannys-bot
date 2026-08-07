import { Request, Response } from "express";

// Per-profile isolated cookie stores
const cookieStores = new Map<number, Map<string, { value: string; domain?: string; path?: string }>>();

export function getCookieStore(profileId: number) {
  if (!cookieStores.has(profileId)) {
    cookieStores.set(profileId, new Map());
  }
  return cookieStores.get(profileId)!;
}

export function clearCookieStore(profileId: number) {
  cookieStores.set(profileId, new Map());
}

function buildCookieHeader(store: Map<string, { value: string; domain?: string; path?: string }>, targetUrl: string): string {
  try {
    const u = new URL(targetUrl);
    const cookies: string[] = [];
    for (const [name, entry] of store.entries()) {
      const domainOk = !entry.domain || u.hostname.endsWith(entry.domain.replace(/^\./, ""));
      const pathOk = !entry.path || u.pathname.startsWith(entry.path);
      if (domainOk && pathOk) cookies.push(`${name}=${entry.value}`);
    }
    return cookies.join("; ");
  } catch {
    return "";
  }
}

function parseSetCookie(header: string) {
  const parts = header.split(";").map((p) => p.trim());
  const first = parts[0];
  const eqIdx = first.indexOf("=");
  if (eqIdx === -1) return null;
  const name = first.slice(0, eqIdx).trim();
  const value = first.slice(eqIdx + 1).trim();
  let domain: string | undefined;
  let path: string | undefined;
  for (const part of parts.slice(1)) {
    const lower = part.toLowerCase();
    if (lower.startsWith("domain=")) domain = part.slice(7);
    else if (lower.startsWith("path=")) path = part.slice(5);
  }
  return { name, value, domain, path };
}

function resolveAbsolute(href: string, base: string): string | null {
  try {
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("data:")) return null;
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * Minimal HTML rewriting:
 * - Rewrites only <a href> for navigation links
 * - Rewrites <form action> so form submissions go through proxy
 * - Adds <base> tag so relative asset URLs resolve against origin (CSS, images, JS load directly from CDN)
 * - Does NOT inject any JS that overrides browser APIs (no pushState loop)
 */
function rewriteHtml(html: string, baseUrl: string, profileId: number, proxyBase: string): string {
  const proxyify = (url: string) => `${proxyBase}?url=${encodeURIComponent(url)}`;

  // Inject <base> so all relative assets (img, script, link, etc.) load from origin CDN directly
  const baseTag = `<base href="${baseUrl}" target="_self">`;
  if (html.includes("<head>")) {
    html = html.replace("<head>", `<head>\n  ${baseTag}`);
  } else if (html.includes("<HEAD>")) {
    html = html.replace("<HEAD>", `<HEAD>\n  ${baseTag}`);
  } else {
    html = baseTag + html;
  }

  // Rewrite <a href="..."> to go through the proxy
  html = html.replace(/(<a\b[^>]*?\s)href\s*=\s*(['"]?)([^'">\s]+)\2/gi, (match, prefix, quote, href) => {
    const abs = resolveAbsolute(href, baseUrl);
    if (!abs) return match;
    return `${prefix}href=${quote}${proxyify(abs)}${quote}`;
  });

  // Rewrite <form action="..."> to go through the proxy
  html = html.replace(/(<form\b[^>]*?\s)action\s*=\s*(['"]?)([^'">\s]+)\2/gi, (match, prefix, quote, action) => {
    const abs = resolveAbsolute(action, baseUrl);
    if (!abs) return match;
    return `${prefix}action=${quote}${proxyify(abs)}${quote}`;
  });

  // Remove X-Frame-Options and CSP meta tags that could block iframe display
  html = html.replace(/<meta[^>]+http-equiv\s*=\s*['"]?x-frame-options['"]?[^>]*>/gi, "");
  html = html.replace(/<meta[^>]+http-equiv\s*=\s*['"]?content-security-policy['"]?[^>]*>/gi, "");

  // Inject minimal script to report current URL to parent (for address bar sync only - no navigation override)
  const reportScript = `<script>
(function(){
  try {
    window.addEventListener('load', function(){
      if(window.parent !== window) {
        window.parent.postMessage({ type: 'urlChange', url: window.location.href }, '*');
      }
    });
  } catch(e) {}
})();
</script>`;

  if (html.includes("</head>")) {
    html = html.replace("</head>", reportScript + "</head>");
  } else if (html.includes("</body>")) {
    html = html.replace("</body>", reportScript + "</body>");
  } else {
    html += reportScript;
  }

  return html;
}

export async function handleBrowserProxy(req: Request, res: Response) {
  const profileId = Number(req.params.profileId);
  const targetUrl = req.query.url as string;
  const userAgent = req.query.ua as string || "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

  if (!targetUrl) {
    return res.status(400).send("Missing url parameter");
  }

  let resolvedUrl: string;
  try {
    resolvedUrl = new URL(targetUrl).toString();
  } catch {
    return res.status(400).send("Invalid URL");
  }

  const cookieStore = getCookieStore(profileId);
  const cookieHeader = buildCookieHeader(cookieStore, resolvedUrl);
  const proxyBase = `/api/browser/${profileId}/proxy`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const fetchResponse = await fetch(resolvedUrl, {
      method: req.method === "POST" ? "POST" : "GET",
      headers: {
        "User-Agent": userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        ...(cookieHeader ? { "Cookie": cookieHeader } : {}),
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // Store cookies from response
    const setCookieList = fetchResponse.headers.getSetCookie?.() ?? [];
    for (const rawCookie of setCookieList) {
      const parsed = parseSetCookie(rawCookie);
      if (parsed) cookieStore.set(parsed.name, { value: parsed.value, domain: parsed.domain, path: parsed.path });
    }

    // Strip security headers that would block iframe display
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");

    const contentType = fetchResponse.headers.get("content-type") || "text/html";
    res.setHeader("Content-Type", contentType);

    if (contentType.includes("text/html")) {
      const text = await fetchResponse.text();
      const rewritten = rewriteHtml(text, resolvedUrl, profileId, proxyBase);
      return res.send(rewritten);
    } else {
      const buffer = Buffer.from(await fetchResponse.arrayBuffer());
      return res.send(buffer);
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return res.status(504).send(`<!DOCTYPE html><html><head><title>Timeout</title></head><body style="font-family:system-ui;padding:40px;"><h2>Request timed out</h2><p>The page at <code>${resolvedUrl}</code> took too long to respond.</p></body></html>`);
    }
    const errorPage = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title>
<style>body{font-family:system-ui,sans-serif;padding:40px;background:#fafafa;color:#333;}h2{color:#c0392b;}code{background:#f0f0f0;padding:2px 6px;border-radius:3px;font-size:.85em;}</style>
</head><body>
<h2>Could not load page</h2>
<p>URL: <code>${resolvedUrl}</code></p>
<p>Error: <code>${err?.message || String(err)}</code></p>
<p style="color:#666;font-size:.9em;">Instagram and some sites block server-side requests. Try a different URL or use the session for sites that allow automated access.</p>
</body></html>`;
    return res.status(200).send(errorPage);
  }
}
