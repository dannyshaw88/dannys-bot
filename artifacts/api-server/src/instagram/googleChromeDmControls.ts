/**
 * Runs in the browser via Puppeteer. Keep all dependencies inside this function.
 * Search outward from the verified composer, never in a different conversation.
 */
export function findGoogleChromeDmControl(element: any, action: "send" | "close"): any {
  const getStyle = (globalThis as any).getComputedStyle;
  const visible = (node: any) => {
    const rect = node.getBoundingClientRect();
    const style = getStyle(node);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== "hidden" && style.display !== "none";
  };
  const editors = "[contenteditable='true'][role='textbox'],textarea";
  let container = element.parentElement;
  for (let depth = 0; container && depth < 12; depth++, container = container.parentElement) {
    // Do not escape into a shared container holding another chat or composer.
    if (Array.from(container.querySelectorAll(editors)).some(node => node !== element && visible(node))) return null;
    const matches = (Array.from(container.querySelectorAll("button,[role='button']")) as any[])
      .filter(button => {
        if (!visible(button) || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
        const labels = [
          button.getAttribute("aria-label"), button.getAttribute("title"),
          button.getAttribute("data-tooltip-content"), button.innerText,
        ].filter(Boolean).map((label: string) => label.replace(/\s+/g, " ").trim());
        return labels.some(label => action === "send"
          ? /^(?:send(?: message)?(?: \((?:press )?enter\))?|press enter to send)$/i.test(label)
          : /^close (?:chat|conversation)(?: with .+)?$/i.test(label));
      });
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }
  return null;
}

/** Resolve the unique Message control from the currently rendered target profile. */
export function findGoogleChromeDmMessageButton(expectedName: string): any {
  const doc = (globalThis as any).document;
  const getStyle = (globalThis as any).getComputedStyle as (element: any) => any;
  const visible = (element: any) => {
    const rect = element.getBoundingClientRect();
    const style = getStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== "hidden" && style.display !== "none";
  };
  const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ").trim().toLowerCase();
  const main = doc.querySelector("main,[role='main']");
  if (!main || !normalize(main.innerText || "").includes(normalize(expectedName))) return false;
  const buttons = (Array.from(main.querySelectorAll("button,[role='button']")) as any[])
    .filter(button => {
      if (!visible(button)) return false;
      const labels = [button.getAttribute("aria-label"), button.getAttribute("title"), button.innerText]
        .filter(Boolean).map((label: string) => label.replace(/\s+/g, " ").trim());
      return labels.some(label => /^message$/i.test(label));
    });
  return buttons.length === 1 ? buttons[0] : false;
}
