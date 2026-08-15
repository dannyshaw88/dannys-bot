---
name: leaksPage.ts client script must be plain JS
description: leaksPage.ts embeds raw browser JS in a template string; TypeScript syntax there is a silent full-page failure, not a type error
---

`leaksPage.ts` builds an HTML page (served via `/api/browser/leaks`) whose `<script>` body is a plain string sent straight to the browser — it is never transpiled. Any TypeScript-only syntax inside that string (e.g. `as any`, type annotations) is invisible to `tsc`/the bundler (it's just string contents) but is a hard `SyntaxError` in the browser, which aborts the entire inline `<script>` block before any of it runs.

**Why:** This causes every card on the Leak Check page to appear stuck (spinners never resolve, "Fetching…"/"Running…" forever) because `runAll()` and all test functions never execute at all — not a network/proxy problem, a JS parse failure. It's easy to introduce by habit when editing a `.ts` file (e.g. writing `(window as any).foo = ...` inside the template string).

**How to apply:** When editing the JS inside `LEAKS_PAGE_HTML` in `leaksPage.ts`, treat it as plain browser JavaScript, not TypeScript — no `as`, no type annotations, no non-null assertions (`!`). If the leak-check page shows all tests permanently pending, check this file first for stray TS syntax before investigating proxy/network causes.
