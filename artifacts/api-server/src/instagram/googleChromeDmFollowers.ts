/** Wait for actual collected rows, not an early page shell or skeleton links. */
export async function waitForGoogleChromeDmFollowers<T>(
  collect: () => Promise<T[]>,
  stopped: () => boolean,
  timeoutMs = 30_000,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 500)),
): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  while (!stopped()) {
    const rows = await collect();
    if (rows.length) return rows;
    if (Date.now() >= deadline) {
      throw new Error("The Followers page opened, but no readable user rows became available. No messages were sent.");
    }
    await pause();
  }
  return [];
}

/** Scroll the Followers list and report whether any relevant scroll surface moved. */
export function scrollGoogleChromeDmFollowers(): {
  scrolled: boolean;
  atBottom: boolean;
  top: number;
  maxTop: number;
  target: string;
} {
  const root = (globalThis as any).document?.scrollingElement;
  const doc = (globalThis as any).document;
  const win = (globalThis as any).window;
  if (!doc || !win) return { scrolled: false, atBottom: true, top: 0, maxTop: 0, target: "missing-document" };

  const main = doc.querySelector("main,[role='main']");
  const headings = main
    ? Array.from(main.querySelectorAll("h1,h2,h3,h4,[role='heading'],span")) as any[]
    : [];
  const heading = headings.reverse().find(element =>
    /^followers$/i.test((element.innerText || element.textContent || "").trim()),
  );
  const targets: Array<{ element: any; page: boolean; label: string }> = [];
  const seen = new Set<any>();
  let container = heading?.parentElement;
  for (let depth = 0; container && container !== doc.body && depth < 12; depth++, container = container.parentElement) {
    const style = (globalThis as any).getComputedStyle(container);
    if (container.scrollHeight > container.clientHeight + 4 && /auto|scroll/.test(style.overflowY) && !seen.has(container)) {
      targets.push({ element: container, page: false, label: "followers-panel" });
      seen.add(container);
    }
  }

  const pageRoot = root ?? doc.documentElement;
  const pageHeight = Math.max(pageRoot?.scrollHeight ?? 0, doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
  const pageViewport = Math.max(1, win.innerHeight ?? pageRoot?.clientHeight ?? 1);
  if (pageRoot && pageHeight > pageViewport + 4 && !seen.has(pageRoot)) {
    targets.push({ element: pageRoot, page: true, label: "page" });
  }

  const metrics = (target: { element: any; page: boolean; label: string }) => {
    const top = target.page ? (win.scrollY ?? target.element.scrollTop ?? 0) : target.element.scrollTop;
    const viewport = target.page ? pageViewport : target.element.clientHeight;
    const height = target.page
      ? Math.max(target.element.scrollHeight ?? 0, doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0)
      : target.element.scrollHeight;
    return { top, maxTop: Math.max(0, height - viewport), viewport, height, target: target.label };
  };

  for (const target of targets) {
    const before = metrics(target);
    if (before.maxTop <= before.top + 4) continue;
    const nextTop = Math.min(before.maxTop, before.top + Math.max(300, Math.floor(before.viewport * 0.75)));
    target.element.scrollTop = nextTop;
    const after = metrics(target);
    if (after.top > before.top + 1) {
      return { scrolled: true, atBottom: false, top: after.top, maxTop: after.maxTop, target: after.target };
    }
  }

  const last = targets.length ? metrics(targets[targets.length - 1]) : { top: 0, maxTop: 0, target: "none" };
  return { scrolled: false, atBottom: true, top: last.top, maxTop: last.maxTop, target: last.target };
}
