/**
 * A cleared composer is not proof that a DM appeared in the conversation.
 * Confirm the exact outgoing text in a visible message row owned by the same
 * chat as the verified composer before counting the send or closing the chat.
 */
export function inspectGoogleChromeDmSentMessage(element: any, expectedText: string): boolean {
  const doc = (globalThis as any).document;
  if (!doc || !element?.isConnected) return false;

  const getStyle = (globalThis as any).getComputedStyle;
  const visible = (node: any) => {
    const rect = node.getBoundingClientRect();
    const style = getStyle(node);
    const viewportWidth = doc.documentElement?.clientWidth ?? (globalThis as any).innerWidth ?? 0;
    const viewportHeight = doc.documentElement?.clientHeight ?? (globalThis as any).innerHeight ?? 0;
    return rect.width > 0 && rect.height > 0 &&
      rect.right > 0 && rect.bottom > 0 &&
      (!viewportWidth || rect.left < viewportWidth) &&
      (!viewportHeight || rect.top < viewportHeight) &&
      style.visibility !== "hidden" && style.display !== "none";
  };
  const normalize = (value: unknown) => String(value ?? "")
    .replace(/\u200b/g, "").replace(/\s+/g, " ").trim();
  const expected = normalize(expectedText);
  if (!expected || normalize(element.innerText || element.textContent || element.value)) return false;

  const editorSelector = "[contenteditable='true'][role='textbox'],textarea";
  const closePattern = /^close (?:chat|conversation)(?: with .+)?$/i;
  let chatPanel: any = null;
  let container = element.parentElement;
  for (let depth = 0; container && depth < 12; depth++, container = container.parentElement) {
    const editors = (Array.from(container.querySelectorAll(editorSelector)) as any[]).filter(visible);
    if (editors.length !== 1 || editors[0] !== element) continue;
    const closeButtons = (Array.from(container.querySelectorAll("button,[role='button']")) as any[])
      .filter(button => visible(button) && [
        button.getAttribute("aria-label"), button.getAttribute("title"), button.innerText,
      ].some(label => closePattern.test(String(label ?? "").replace(/\s+/g, " ").trim())));
    if (closeButtons.length === 1) {
      chatPanel = container;
      break;
    }
  }
  if (!chatPanel) return false;

  const rows = Array.from(chatPanel.querySelectorAll(
    "[role='row'],[data-message-id],[data-messageid],[data-testid='message-container']",
  )) as any[];
  return rows.some(row => {
    if (row.contains(element) || !visible(row)) return false;
    return normalize(row.innerText || row.textContent).includes(expected);
  });
}
