import { jarveeProfileAgentPairs, jarveeSupplementalEmbeddedAgents } from "./jarveeProfileAgents";

const jarveeEmbeddedBrowserUserAgents = [
  "Mozilla/5.0 (Linux; Android 9; SM-N950F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; SM-A505U1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 8.1.0; potter_nt) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; SM-G975U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; SM-G975U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; SM-A530F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 11; OP4B65L1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; SM-G950U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 11; crosshatch) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 8.1.0; BBB100-5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; MAR-LX1A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; OnePlus7TProNR) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; ASUS_A001D_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; MHA-L09) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 8.1.0; SM-A710K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 8.1.0; SM-A800I) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; STK-L21) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; MAR-LX1M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; VOG-L29) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; HMA-L29) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; OnePlus7Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; SM-A730F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; SM-G950F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; SM-N950U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; SM-A530F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 8.1.0; ASUS_X00DD) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; AQM-LX1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; ASUS_X00T_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 8.1.0; LM-Q610(FGN)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; STK-LX1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; SM-G981U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 11; SM-G973W) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; violet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; bolt) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; SM-G955U1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; JSN-L22) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; SM-G981U1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; SM-G965F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; HRY-LX1T) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 9; SM-G965N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; SM-G970U1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36",
  ...jarveeProfileAgentPairs.map(pair => pair.embedded),
  ...jarveeSupplementalEmbeddedAgents,
] as const;

function parsedAgent(userAgent: string) {
  const edgeVersion = userAgent.match(/Edg(?:A|iOS)?\/([\d.]+)/)?.[1]?.split(".")[0];
  const firefoxVersion = userAgent.match(/(?:Firefox|FxiOS)\/([\d.]+)/)?.[1]?.split(".")[0];
  const chromeVersion = userAgent.match(/(?:Chrome|CriOS)\/([\d.]+)/)?.[1]?.split(".")[0];
  const browser = edgeVersion
    ? `Edge ${edgeVersion}`
    : firefoxVersion
      ? `Firefox ${firefoxVersion}`
      : chromeVersion
        ? `Chrome ${chromeVersion}`
        : "Browser";
  const android = userAgent.match(/Android ([^;]+); ([^)]+)\)/);
  if (android) {
    const model = android[2];
    return {
      brand: agentBrand(model),
      model,
      detail: `Android ${android[1]} · ${browser}`,
    };
  }
  if (userAgent.includes("Windows NT 10.0")) {
    return { brand: "Windows", model: "Windows 10", detail: browser };
  }
  return { brand: "Other", model: "Unknown device", detail: browser };
}

function agentBrand(model: string): string {
  if (/^(SM-|GT-|SCH-|SGH-|SHW-)/i.test(model)) return "Samsung";
  if (/^(pixel|crosshatch|panther|shiba|caiman|tokay|komodo|comet|lynx|akita|sargo|sunfish|walleye)/i.test(model)) return "Google";
  if (/^oneplus/i.test(model)) return "OnePlus";
  if (/^(violet|redmi|poco|joyeuse|merlinnfc|curtana)/i.test(model)) return "Xiaomi";
  if (/^(potter|moto|doha_n)/i.test(model)) return "Motorola";
  if (/^asus_/i.test(model)) return "ASUS";
  if (/^bbb/i.test(model)) return "BlackBerry";
  if (/^lm-/i.test(model)) return "LG";
  if (/^rmx/i.test(model)) return "realme";
  if (/^(mar|vog|hma|stk|aqm|hry|jsn|pot|ele|aln|yal|sne)-/i.test(model)) return "Huawei / Honor";
  return "Other Android";
}

const agentBrandOrder = [
  "Google", "Samsung", "OnePlus", "Xiaomi", "Motorola", "OPPO", "vivo",
  "realme", "ASUS", "BlackBerry", "Huawei / Honor", "LG", "Windows", "Other Android", "Other",
];

export function describeEmbeddedBrowserAgent(userAgent: string): string {
  const { model, detail } = parsedAgent(userAgent);
  return `${model} · ${detail}`;
}

export const embeddedBrowserAgentPresets = [...new Set(jarveeEmbeddedBrowserUserAgents)]
  .map(userAgent => {
    const { brand, model, detail } = parsedAgent(userAgent);
    return {
      brand,
      label: `${model} · ${detail}`,
      model,
      detail,
      userAgent,
      searchText: `${brand} ${model} ${detail} ${userAgent}`,
    };
  })
  .sort((a, b) => {
    const aOrder = agentBrandOrder.indexOf(a.brand);
    const bOrder = agentBrandOrder.indexOf(b.brand);
    return (aOrder - bOrder) || a.model.localeCompare(b.model) || a.detail.localeCompare(b.detail);
  });