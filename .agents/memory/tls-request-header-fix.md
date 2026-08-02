---
name: tlsRequest CycleTLS header stripping
description: Why tlsRequest must strip Host, Connection, Content-Length before passing to CycleTLS — or Instagram returns "something went wrong" on every write call
---

## The rule

`tlsRequest()` in `tlsTransport.ts` must strip `Host`, `Connection`, and `Content-Length` from the header map before passing to CycleTLS, in addition to `User-Agent` and `Accept-Encoding`.

## Why

CycleTLS uses Go's `fhttp` transport which negotiates HTTP/2 with Instagram's servers. HTTP/2 has strict rules:

- **Host** → replaced by `:authority` pseudo-header derived from the URL. Passing `Host` as a regular header alongside the auto-generated `:authority` causes a header conflict. Instagram rejects with HTTP 200 `status:"fail"` "We're sorry, but something went wrong."
- **Connection** → hop-by-hop header, FORBIDDEN in HTTP/2 (RFC 7540 §8.1.2.2). IgApiClient injects `Connection: close` via `getDefaultHeaders()`. This was the confirmed cause of the friendship.create "something went wrong" through the IgApiClient path.
- **Content-Length** → Go's fhttp sets this automatically from the body string. Passing it manually produces a duplicate Content-Length header which Instagram can reject.

## How to apply

In the CycleTLS path of `tlsRequest` (the `if (!forceNodeTls)` branch), destructure out all five headers before using `headersWithoutUA`:

```js
const {
  "User-Agent": _ua,
  "Accept-Encoding": _ae,
  "Host": _host,
  "Connection": _conn,
  "Content-Length": _cl,
  ...headersWithoutUA
} = allHeaders;
```

Do NOT add Content-Length to `allHeaders` at the top of `tlsRequest` — only the Node.js forceNodeTls path needs it, and Node.js sets it automatically from `req.write(body)` anyway.

`patchIgClientTls` (the IgApiClient path) already does this correctly. The bug was that `tlsRequest` (used by all direct `igReq()` calls) was missing these strips.

**Why:** This was confirmed as the root cause of "something went wrong" on every follow/unfollow/DM call after switching from Node.js HTTPS to CycleTLS. The Node.js HTTPS path uses HTTP/1.1 where Host and Content-Length are valid regular headers; HTTP/2 treats them differently.
