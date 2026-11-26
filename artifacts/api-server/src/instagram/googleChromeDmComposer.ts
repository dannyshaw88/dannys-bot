/**
 * Find the composer only inside the one visible chat for the verified profile.
 * Facebook changes composer accessibility labels between Messenger variants,
 * so recipient identity is validated from that chat's header instead.
 */
export function findGoogleChromeDmComposer(expectedName: string): any {
  const doc = (globalThis as any).document;
  const getStyle = (globalThis as any).getComputedStyle;
  const visible = (node: any) => {
    const rect = node.getBoundingClientRect();
    const style = getStyle(node);
    return !!rect.width && !!rect.height && style.visibility !== "hidden" && style.display !== "none";
  };
  const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ").trim().toLowerCase();
  const expected = normalize(expectedName);
  const matchesHeader = (value: string) => {
    const label = normalize(value);
    return label === expected || label.startsWith(`${expected} active now`) ||
      label.startsWith(`${expected} active`) || label.startsWith(`${expected} available`);
  };
  const closePattern = /^close (?:chat|conversation)(?: with .+)?$/i;
  const editors = Array.from(doc.querySelectorAll("[contenteditable='true'][role='textbox'],textarea")) as any[];
  const matched: any[] = [];
  for (const editor of editors) {
    if (!visible(editor)) continue;
    let panel = editor.parentElement;
    for (let depth = 0; panel && depth < 12; depth++, panel = panel.parentElement) {
      const panelEditors = (Array.from(panel.querySelectorAll(
        "[contenteditable='true'][role='textbox'],textarea",
      )) as any[]).filter(visible);
      if (panelEditors.length !== 1 || panelEditors[0] !== editor) continue;
      const controls = (Array.from(panel.querySelectorAll("button,[role='button']")) as any[])
        .filter(button => visible(button) && [
          button.getAttribute("aria-label"), button.getAttribute("title"), button.innerText,
        ].some(label => closePattern.test(String(label ?? "").replace(/\s+/g, " ").trim())));
      if (controls.length !== 1) continue;
      const labels = Array.from(panel.querySelectorAll(
        "h1,h2,h3,h4,h5,h6,[role='heading'],button,[role='button'],[title],[aria-label]",
      )) as any[];
      const headerMatches = labels.some(node => visible(node) && [
        node.getAttribute("aria-label"), node.getAttribute("title"), node.innerText, node.textContent,
      ].some(value => matchesHeader(String(value ?? ""))));
      const leadingText = String(panel.innerText || "").replace(/^\s+/, "");
      if (headerMatches || matchesHeader(leadingText.split(/\n/u, 1)[0] ?? "")) {
        matched.push(editor);
      }
      break;
    }
  }
  return matched.length === 1 ? matched[0] : false;
}

/**
 * Return selector diagnostics without recording message text or recipient names.
 * Used only when a clicked Message control fails to reveal a verified composer.
 */
export function diagnoseGoogleChromeDmComposer(expectedName: string): {
  path: string;
  visibleEditors: number;
  supportedEditors: number;
  recipientLabelEditors: number;
  visibleCloseControls: number;
  recipientHeaderMatched: boolean;
} {
  const doc = (globalThis as any).document;
  if (!doc) {
    return {
      path: "",
      visibleEditors: 0,
      supportedEditors: 0,
      recipientLabelEditors: 0,
      visibleCloseControls: 0,
      recipientHeaderMatched: false,
    };
  }
  const getStyle = (globalThis as any).getComputedStyle as (element: any) => any;
  const visible = (node: any) => {
    const rect = node.getBoundingClientRect();
    const style = getStyle(node);
    return !!rect.width && !!rect.height && style.visibility !== "hidden" && style.display !== "none";
  };
  const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ").trim().toLowerCase();
  const expected = normalize(expectedName);
  const editors = Array.from(doc.querySelectorAll(
    "[contenteditable='true'],[role='textbox'],textarea,input",
  ) as any[]).filter(visible);
  const supported = editors.filter(element =>
    element.matches?.("[contenteditable='true'][role='textbox'],textarea"),
  );
  const recipientLabels = supported.filter(element => {
    const label = [
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("data-placeholder"),
    ].filter(Boolean).join(" ");
    return normalize(label).includes(expected);
  });
  const closeControls = (Array.from(doc.querySelectorAll("button,[role='button']")) as any[])
    .filter(button => visible(button) && [
      button.getAttribute("aria-label"), button.getAttribute("title"), button.innerText,
    ].some(label => /^close (?:chat|conversation)(?: with .+)?$/i.test(String(label ?? "").trim())));
  const headerNodes = Array.from(doc.querySelectorAll(
    "h1,h2,h3,h4,h5,h6,[role='heading'],button,[role='button'],[title],[aria-label]",
  ) as any[]);
  const recipientHeaderMatched = headerNodes.some(node => visible(node) && [
    node.getAttribute("aria-label"), node.getAttribute("title"), node.innerText, node.textContent,
  ].some(value => {
    const label = normalize(String(value ?? ""));
    return label === expected || label.startsWith(`${expected} active`) ||
      label.startsWith(`${expected} available`);
  }));
  return {
    path: String(doc.location?.pathname ?? "").slice(0, 120),
    visibleEditors: editors.length,
    supportedEditors: supported.length,
    recipientLabelEditors: recipientLabels.length,
    visibleCloseControls: closeControls.length,
    recipientHeaderMatched,
  };
}
