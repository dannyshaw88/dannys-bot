/**
 * Phone Farm — device grid entry point.
 *
 * Shows a 3-column × 2-row grid (6 slots max).
 * Only slots up to the next available one are visible:
 *   • Registered devices  → device card, click → open that phone's control page
 *   • Next empty slot     → "Add Device" card, click → inline USB phone picker
 *   • All slots beyond    → hidden
 *
 * Slot assignments are persisted in the DB (phone_farm_devices table) keyed
 * by ADB serial number — NOT by USB port. Swapping cable connections never
 * reassigns slots because the serial travels with the hardware, not the wire.
 */

import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from "react";
import { useLocation } from "wouter";
import { Sidebar } from "@/components/layout/Sidebar";
import { LiveActivityTicker } from "@/components/layout/LiveActivityTicker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Usb, Plus, Wifi, WifiOff, AlertTriangle, Trash2, RefreshCw, Palette, Power, X, ImagePlus, BookOpen, Clapperboard, BarChart2, Activity, MessageCircle, Upload, Shuffle, CheckCircle2, UserPlus, UserRound, RotateCcw, Download, ChevronDown, Check } from "lucide-react";
import { pickLocalWallpaper } from "@/pages/mobileShared";
import { writeUiSpeedLog } from "@/lib/uiSpeedLog";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FarmDevice {
  slotIndex:      number;
  serial:         string;
  displayName:    string;
  model:          string;
  manufacturer:   string;
  androidVersion: string;
  addedAt:        string;
}

function toolVisual(tool: string): { label: string; icon: React.ReactNode } {
  const iconClass = "w-3.5 h-3.5 shrink-0";
  if (tool === "FINALISING") return { label: "Finishing", icon: <CheckCircle2 className={iconClass} /> };
  if (tool === "Random Actions") return { label: "Random Actions", icon: <Shuffle className={iconClass} /> };
  if (/Reel/i.test(tool)) return { label: tool, icon: <Clapperboard className={iconClass} /> };
  if (/Story/i.test(tool)) return { label: tool, icon: <BookOpen className={iconClass} /> };
  if (/Explore/i.test(tool)) return { label: tool, icon: <Activity className={iconClass} /> };
  if (/Feed/i.test(tool)) return { label: tool, icon: <BarChart2 className={iconClass} /> };
  if (/Direct|DM|Messaging/i.test(tool)) return { label: tool, icon: <MessageCircle className={iconClass} /> };
  if (/Follow/i.test(tool)) return { label: tool, icon: <UserPlus className={iconClass} /> };
  if (/Post|Avatar|Profile/i.test(tool)) return { label: tool, icon: <Upload className={iconClass} /> };
  return { label: tool, icon: <Activity className={iconClass} /> };
}

interface UsbPhone {
  serial:          string;
  state:           "device" | "unauthorized" | "offline" | string;
  model?:          string;
  marketName?:     string;
  manufacturer?:   string;
  androidVersion?: string;
}


// ─── Model code → friendly name lookup ───────────────────────────────────────
// Maps raw Android model codes (ro.product.model) to human-readable names.
// Used to display "Xiaomi Redmi Note 12" instead of "Xiaomi 23076RN8DY" for
// devices that were registered before marketname detection was added.
const MODEL_FRIENDLY_NAME: Record<string, string> = {
  // Redmi Note series
  "23076RN8DY": "Redmi Note 12", "23076RN8DC": "Redmi Note 12",
  "23046RP50C": "Redmi Note 12 Pro+", "23076RA4BC": "Redmi Note 12 Pro",
  "25028RN03Y": "Redmi Note 14", "25028RN03C": "Redmi Note 14",
  "22111317I":  "Redmi Note 11",  "22111317G":  "Redmi Note 11",
  "2201116SY":  "Redmi Note 11 Pro+",
  "21091116AG": "Redmi Note 10S", "21061119AG": "Redmi Note 10 Pro",
  "2107113SG":  "Redmi Note 10 5G", "M2103K19G": "Redmi Note 10",
  "M2003J15SC": "Redmi Note 9 Pro",
  // Xiaomi main series
  "23129RAA4G": "Xiaomi 14",    "2312DRAAEE": "Xiaomi 13",
  "23013RK75C": "Xiaomi 13T",   "23049PCD8G": "Xiaomi 13T Pro",
  "2211133G":   "Xiaomi 12T",   "22071212AG": "Xiaomi 12 Lite",
  "2201123G":   "Xiaomi 12",    "21122221G":  "Xiaomi 11T",
  // POCO
  "22081212UG": "POCO X5 Pro",  "22111317PG": "POCO X5",
  "22101320G":  "POCO M5",      "21121210G":  "POCO M4 Pro",
  "22041219PG": "POCO C40",
  // Redmi main series
  "220333QAG":  "Redmi 10C",    "21121119SR": "Redmi 10",
};


function resolveDisplayName(device: FarmDevice, phone?: UsbPhone): string {
  // Live ADB marketName is most accurate — prefer it over any cached/lookup value.
  const liveMarket = phone?.marketName?.trim();
  if (liveMarket) {
    const mfr = (phone?.manufacturer?.trim() || device.manufacturer?.trim());
    return mfr ? `${mfr} ${liveMarket}` : liveMarket;
  }
  // Check device.model against the lookup table.
  const code = device.model?.trim();
  if (code && MODEL_FRIENDLY_NAME[code]) {
    const mfr = device.manufacturer?.trim();
    return mfr ? `${mfr} ${MODEL_FRIENDLY_NAME[code]}` : MODEL_FRIENDLY_NAME[code];
  }
  // Also check device.serial — Xiaomi devices publish their model code as the
  // USB serial, so a phone registered before marketname detection was added
  // can still resolve to a friendly name via the serial.
  const sCode = device.serial?.trim();
  if (sCode && MODEL_FRIENDLY_NAME[sCode]) {
    const mfr = device.manufacturer?.trim();
    return mfr ? `${mfr} ${MODEL_FRIENDLY_NAME[sCode]}` : MODEL_FRIENDLY_NAME[sCode];
  }
  return device.displayName || device.serial;
}

// ─── Slot customization types & constants ────────────────────────────────────

const SLOT_FONTS = [
  { id: 'inter',    label: 'Inter',       family: "'Inter', system-ui, sans-serif" },
  { id: 'oswald',   label: 'Oswald',      family: "'Oswald', sans-serif" },
  { id: 'bebas',    label: 'Bebas Neue',  family: "'Bebas Neue', cursive" },
  { id: 'playfair', label: 'Playfair',    family: "'Playfair Display', serif" },
  { id: 'pacifico', label: 'Pacifico',    family: "'Pacifico', cursive" },
  { id: 'mono',     label: 'Mono',        family: "'Courier New', monospace" },
  { id: 'impact',   label: 'Impact',      family: "Impact, fantasy" },
  { id: 'serif',    label: 'Serif',       family: "Georgia, serif" },
] as const;

const SLOT_WALLPAPERS = [
  // — originals —
  { id: 'wp-galaxy.jpg',    label: 'Galaxy' },
  { id: 'wp-abstract.jpg',  label: 'Abstract' },
  { id: 'wp-forest.jpg',    label: 'Forest' },
  { id: 'wp-ocean.jpg',     label: 'Ocean' },
  { id: 'wp-mountains.jpg', label: 'Mountains' },
  { id: 'wp-city.jpg',      label: 'City' },
  { id: 'wp-purple.jpg',    label: 'Purple' },
  { id: 'wp-minimal.jpg',   label: 'Minimal' },
  { id: 'wp-blossom.jpg',   label: 'Blossom' },
  { id: 'wp-aurora.jpg',    label: 'Aurora' },
  { id: 'wp-neon.jpg',      label: 'Neon' },
  { id: 'wp-water.jpg',     label: 'Water' },
  // — nature —
  { id: 'wp-p10.jpg',  label: 'Deer' },
  { id: 'wp-p11.jpg',  label: 'Fog' },
  { id: 'wp-p12.jpg',  label: 'Lake' },
  { id: 'wp-p13.jpg',  label: 'Valley' },
  { id: 'wp-p14.jpg',  label: 'River' },
  { id: 'wp-p15.jpg',  label: 'Waterfall' },
  { id: 'wp-p16.jpg',  label: 'Pines' },
  { id: 'wp-p17.jpg',  label: 'Moss' },
  { id: 'wp-p18.jpg',  label: 'Stream' },
  { id: 'wp-p19.jpg',  label: 'Meadow' },
  { id: 'wp-p20.jpg',  label: 'Hills' },
  { id: 'wp-p21.jpg',  label: 'Cliff' },
  { id: 'wp-p22.jpg',  label: 'Birch' },
  { id: 'wp-p23.jpg',  label: 'Ferns' },
  { id: 'wp-p24.jpg',  label: 'Tundra' },
  { id: 'wp-p25.jpg',  label: 'Dunes' },
  { id: 'wp-p26.jpg',  label: 'Lagoon' },
  { id: 'wp-p27.jpg',  label: 'Palm' },
  { id: 'wp-p28.jpg',  label: 'Tropical' },
  { id: 'wp-p29.jpg',  label: 'Jungle' },
  { id: 'wp-p30.jpg',  label: 'Tide' },
  { id: 'wp-p31.jpg',  label: 'Shore' },
  { id: 'wp-p32.jpg',  label: 'Reef' },
  { id: 'wp-p33.jpg',  label: 'Coral' },
  { id: 'wp-p37.jpg',  label: 'Sunflower' },
  { id: 'wp-p39.jpg',  label: 'Petals' },
  { id: 'wp-p40.jpg',  label: 'Bloom' },
  { id: 'wp-p42.jpg',  label: 'Garden' },
  { id: 'wp-p43.jpg',  label: 'Rain' },
  { id: 'wp-p44.jpg',  label: 'Mist' },
  { id: 'wp-p45.jpg',  label: 'Snow' },
  { id: 'wp-p46.jpg',  label: 'Frost' },
  { id: 'wp-p47.jpg',  label: 'Ice' },
  { id: 'wp-p48.jpg',  label: 'Glacier' },
  { id: 'wp-p49.jpg',  label: 'Storm' },
  { id: 'wp-p50.jpg',  label: 'Lightning' },
  // — architecture & city —
  { id: 'wp-p60.jpg',  label: 'Streets' },
  { id: 'wp-p61.jpg',  label: 'Bridge' },
  { id: 'wp-p62.jpg',  label: 'Skyline' },
  { id: 'wp-p63.jpg',  label: 'Alley' },
  { id: 'wp-p64.jpg',  label: 'Rooftop' },
  { id: 'wp-p65.jpg',  label: 'Tunnel' },
  { id: 'wp-p66.jpg',  label: 'Station' },
  { id: 'wp-p67.jpg',  label: 'Facade' },
  { id: 'wp-p68.jpg',  label: 'Arch' },
  { id: 'wp-p69.jpg',  label: 'Pillars' },
  { id: 'wp-p70.jpg',  label: 'Stairs' },
  { id: 'wp-p71.jpg',  label: 'Door' },
  { id: 'wp-p72.jpg',  label: 'Window' },
  { id: 'wp-p73.jpg',  label: 'Tower' },
  { id: 'wp-p74.jpg',  label: 'Spire' },
  { id: 'wp-p75.jpg',  label: 'Dome' },
  // — space & dark —
  { id: 'wp-p100.jpg', label: 'Nebula' },
  { id: 'wp-p101.jpg', label: 'Cosmos' },
  { id: 'wp-p102.jpg', label: 'Orbit' },
  { id: 'wp-p103.jpg', label: 'Crater' },
  { id: 'wp-p104.jpg', label: 'Asteroid' },
  { id: 'wp-p105.jpg', label: 'Eclipse' },
  { id: 'wp-p106.jpg', label: 'Pulsar' },
  { id: 'wp-p107.jpg', label: 'Void' },
  // — abstract & patterns —
  { id: 'wp-p200.jpg', label: 'Ink' },
  { id: 'wp-p201.jpg', label: 'Splash' },
  { id: 'wp-p202.jpg', label: 'Gradient' },
  { id: 'wp-p203.jpg', label: 'Marble' },
  { id: 'wp-p204.jpg', label: 'Crystal' },
  { id: 'wp-p205.jpg', label: 'Prism' },
  { id: 'wp-p206.jpg', label: 'Glitch' },
  { id: 'wp-p207.jpg', label: 'Wave' },
  { id: 'wp-p208.jpg', label: 'Ripple' },
  { id: 'wp-p209.jpg', label: 'Fractal' },
  { id: 'wp-p210.jpg', label: 'Vortex' },
  { id: 'wp-p211.jpg', label: 'Lattice' },
  // — animals —
  { id: 'wp-p300.jpg', label: 'Wolf' },
  { id: 'wp-p301.jpg', label: 'Eagle' },
  { id: 'wp-p302.jpg', label: 'Tiger' },
  { id: 'wp-p303.jpg', label: 'Fox' },
  { id: 'wp-p304.jpg', label: 'Bear' },
  { id: 'wp-p305.jpg', label: 'Owl' },
  { id: 'wp-p306.jpg', label: 'Leopard' },
  { id: 'wp-p307.jpg', label: 'Raven' },
  // — warm / golden —
  { id: 'wp-p400.jpg', label: 'Dusk' },
  { id: 'wp-p401.jpg', label: 'Ember' },
  { id: 'wp-p402.jpg', label: 'Flame' },
  { id: 'wp-p403.jpg', label: 'Amber' },
  { id: 'wp-p404.jpg', label: 'Copper' },
  { id: 'wp-p405.jpg', label: 'Rust' },
  { id: 'wp-p406.jpg', label: 'Terracotta' },
  { id: 'wp-p407.jpg', label: 'Crimson' },
  // — cool / blue —
  { id: 'wp-p500.jpg', label: 'Azure' },
  { id: 'wp-p501.jpg', label: 'Sapphire' },
  { id: 'wp-p502.jpg', label: 'Cobalt' },
  { id: 'wp-p503.jpg', label: 'Indigo' },
  { id: 'wp-p504.jpg', label: 'Teal' },
  { id: 'wp-p505.jpg', label: 'Cyan' },
  { id: 'wp-p506.jpg', label: 'Seafoam' },
  { id: 'wp-p507.jpg', label: 'Aqua' },
  // — minimal / pastel —
  { id: 'wp-p600.jpg', label: 'Linen' },

  { id: 'wp-p602.jpg', label: 'Ash' },
  { id: 'wp-p603.jpg', label: 'Pearl' },
];

interface TextLayer {
  id: string; text: string; font: string; size: number; color: string;
  x: number; y: number; bold: boolean; italic: boolean; shadow: boolean;
}

interface SlotCustomization {
  wallpaper: string | null;
  texts: TextLayer[];
  simCountryCode?: string;
  simProvider?: string | null;
}
const DEFAULT_SLOT_CUSTOM: SlotCustomization = {
  wallpaper: null,
  texts: [],
  simCountryCode: "GB",
  simProvider: null,
};

interface SimCountry {
  code: string;
  dialCode: string;
  name: string;
  providers: string[];
}

const SIM_COUNTRIES: SimCountry[] = [
  { code: "GB", dialCode: "+44", name: "United Kingdom", providers: ["EE", "O2", "Three", "Vodafone", "giffgaff", "Tesco Mobile", "iD Mobile", "VOXI", "Smarty"] },
  { code: "US", dialCode: "+1", name: "United States", providers: ["AT&T", "T-Mobile", "Verizon", "UScellular", "Visible", "Mint Mobile", "Cricket"] },
  { code: "CA", dialCode: "+1", name: "Canada", providers: ["Bell", "Rogers", "TELUS", "Freedom Mobile", "Fido", "Koodo", "Virgin Plus"] },
  { code: "AU", dialCode: "+61", name: "Australia", providers: ["Telstra", "Optus", "Vodafone", "amaysim", "Boost Mobile", "Belong"] },
  { code: "DE", dialCode: "+49", name: "Germany", providers: ["Telekom", "Vodafone", "O2", "1&1", "Aldi Talk", "Congstar"] },
  { code: "FR", dialCode: "+33", name: "France", providers: ["Orange", "SFR", "Bouygues Telecom", "Free Mobile", "Lebara", "NRJ Mobile"] },
  { code: "ES", dialCode: "+34", name: "Spain", providers: ["Movistar", "Vodafone", "Orange", "Yoigo", "MásMóvil", "Digi"] },
  { code: "IT", dialCode: "+39", name: "Italy", providers: ["TIM", "Vodafone", "WindTre", "Iliad", "Fastweb", "ho. Mobile"] },
  { code: "IN", dialCode: "+91", name: "India", providers: ["Jio", "Airtel", "Vi", "BSNL", "MTNL"] },
  { code: "NL", dialCode: "+31", name: "Netherlands", providers: ["KPN", "Vodafone", "Odido", "Lebara", "Simyo", "Youfone"] },
  { code: "IE", dialCode: "+353", name: "Ireland", providers: ["Three", "Vodafone", "eir", "Tesco Mobile", "GoMo"] },
  { code: "ZA", dialCode: "+27", name: "South Africa", providers: ["Vodacom", "MTN", "Cell C", "Telkom", "Rain"] },
];

function getSimCountry(code: string | undefined): SimCountry {
  return SIM_COUNTRIES.find(country => country.code === code) ?? SIM_COUNTRIES[0];
}

function SimFlag({ code }: { code: string }) {
  const svgProps = {
    className: "h-4 w-6 shrink-0",
    viewBox: "0 0 20 14",
    xmlns: "http://www.w3.org/2000/svg",
    "aria-hidden": true,
  };

  switch (code) {
    case "GB":
      return (
        <svg {...svgProps}>
          <rect width="20" height="14" fill="#1f3c88" />
          <path d="M0 0 20 14M20 0 0 14" stroke="#fff" strokeWidth="4" />
          <path d="M0 0 20 14M20 0 0 14" stroke="#c8102e" strokeWidth="1.6" />
          <path d="M10 0v14M0 7h20" stroke="#fff" strokeWidth="4" />
          <path d="M10 0v14M0 7h20" stroke="#c8102e" strokeWidth="2" />
        </svg>
      );
    case "US":
      return (
        <svg {...svgProps}>
          {Array.from({ length: 7 }, (_, index) => (
            <rect key={index} y={index * 2} width="20" height="1" fill="#b22234" />
          ))}
          <rect width="9" height="7.5" fill="#3c3b6e" />
          <circle cx="2" cy="2" r=".45" fill="#fff" /><circle cx="4" cy="2" r=".45" fill="#fff" />
          <circle cx="6" cy="2" r=".45" fill="#fff" /><circle cx="3" cy="4" r=".45" fill="#fff" />
          <circle cx="5" cy="4" r=".45" fill="#fff" /><circle cx="7" cy="4" r=".45" fill="#fff" />
        </svg>
      );
    case "CA":
      return (
        <svg {...svgProps}>
          <rect width="20" height="14" fill="#fff" />
          <rect width="4.5" height="14" fill="#d52b1e" /><rect x="15.5" width="4.5" height="14" fill="#d52b1e" />
          <path d="m10 3 .8 2.2 2-.8-.9 2 1.8 1.1-2.2.3.2 2.3-1.7-1.5-1.7 1.5.2-2.3-2.2-.3 1.8-1.1-.9-2 2 .8z" fill="#d52b1e" />
        </svg>
      );
    case "AU":
      return (
        <svg {...svgProps}>
          <rect width="20" height="14" fill="#012169" />
          <path d="M0 0 10 7M10 0 0 7" stroke="#fff" strokeWidth="2" />
          <path d="M0 0 10 7M10 0 0 7" stroke="#c8102e" strokeWidth=".8" />
          <path d="M5 0v7M0 3.5h10" stroke="#fff" strokeWidth="2" />
          <path d="M5 0v7M0 3.5h10" stroke="#c8102e" strokeWidth="1" />
          <circle cx="15" cy="9" r="1.2" fill="#fff" /><circle cx="12.5" cy="11.3" r=".6" fill="#fff" />
          <circle cx="17.5" cy="11.2" r=".6" fill="#fff" />
        </svg>
      );
    case "DE":
      return <svg {...svgProps}><rect width="20" height="14" fill="#ffce00" /><rect width="20" height="9.3" fill="#dd0000" /><rect width="20" height="4.7" fill="#000" /></svg>;
    case "FR":
      return <svg {...svgProps}><rect width="20" height="14" fill="#ed2939" /><rect width="13.3" height="14" fill="#fff" /><rect width="6.7" height="14" fill="#0055a4" /></svg>;
    case "ES":
      return <svg {...svgProps}><rect width="20" height="14" fill="#ffc400" /><rect width="20" height="3.2" fill="#c60b1e" /><rect y="10.8" width="20" height="3.2" fill="#c60b1e" /></svg>;
    case "IT":
      return <svg {...svgProps}><rect width="20" height="14" fill="#ce2b37" /><rect width="13.3" height="14" fill="#fff" /><rect width="6.7" height="14" fill="#009246" /></svg>;
    case "IN":
      return <svg {...svgProps}><rect width="20" height="14" fill="#128807" /><rect width="20" height="9.3" fill="#fff" /><rect width="20" height="4.7" fill="#ff9933" /><circle cx="10" cy="7" r="1.5" fill="none" stroke="#000080" strokeWidth=".45" /></svg>;
    case "NL":
      return <svg {...svgProps}><rect width="20" height="14" fill="#21468b" /><rect width="20" height="9.3" fill="#fff" /><rect width="20" height="4.7" fill="#ae1c28" /></svg>;
    case "IE":
      return <svg {...svgProps}><rect width="20" height="14" fill="#ff883e" /><rect width="13.3" height="14" fill="#fff" /><rect width="6.7" height="14" fill="#169b62" /></svg>;
    case "ZA":
      return (
        <svg {...svgProps}>
          <rect width="20" height="14" fill="#007a4d" />
          <path d="M0 0v14l8-7z" fill="#ffb81c" /><path d="M0 1.7v10.6L7.5 7z" fill="#000" />
          <path d="M0 0v2.2L7.5 7 0 11.8V14l10-7z" fill="#de3831" />
          <path d="M0 0h20v4.2L11.8 7 20 9.8V14H0v-2.2L8.2 7 0 2.2z" fill="#fff" />
          <path d="M0 0h20v3L10 7 20 11v3H0v-3L10 7 0 3z" fill="#002395" />
          <path d="M0 0h20v2.2L10 7 20 11.8V14h-3.7L10 9 3.7 14H0v-2.2L8.2 7 0 2.2z" fill="#de3831" />
          <path d="M0 0v2.2L8.2 7 0 11.8V14h3.7L10 9l6.3 5H20v-2.2L11.8 7 20 2.2V0h-3.7L10 5 3.7 0z" fill="#007a4d" />
        </svg>
      );
    default:
      return <svg {...svgProps}><rect width="20" height="14" rx="1" fill="#d1d5db" /></svg>;
  }
}

function SimCardSelector({
  custom,
  onChange,
  centerX,
}: {
  custom: SlotCustomization;
  onChange: (custom: SlotCustomization) => void;
  centerX: number | null;
}) {
  const [openMenu, setOpenMenu] = useState<"country" | "provider" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const country = getSimCountry(custom.simCountryCode);
  const selectedProvider = country.providers.includes(custom.simProvider ?? "")
    ? custom.simProvider
    : null;

  useEffect(() => {
    if (!openMenu) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [openMenu]);

  const chooseCountry = (nextCountry: SimCountry) => {
    onChange({
      ...custom,
      simCountryCode: nextCountry.code,
      simProvider: null,
    });
    setOpenMenu(null);
  };

  const chooseProvider = (provider: string) => {
    onChange({
      ...custom,
      simCountryCode: country.code,
      simProvider: provider,
    });
    setOpenMenu(null);
  };

  return (
    <div
      ref={rootRef}
      style={{ left: centerX === null ? "82%" : `${centerX}px` }}
      className="absolute top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 items-center gap-0"
      onClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        title={`SIM country: ${country.name}`}
        aria-label={`Choose SIM country, currently ${country.name}`}
        onClick={() => setOpenMenu(openMenu === "country" ? null : "country")}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-transparent text-foreground hover:bg-accent/50"
      >
        <SimFlag code={country.code} />
      </button>

      {openMenu === "country" && (
        <div className="absolute bottom-[calc(100%+4px)] left-0 z-30 max-h-[7.5rem] w-44 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-xl">
          {SIM_COUNTRIES.map(option => (
            <button
              key={option.code}
              type="button"
              onClick={() => chooseCountry(option)}
              className="flex h-6 w-full items-center gap-2 rounded px-2 text-left text-[10px] text-popover-foreground hover:bg-accent"
            >
              <SimFlag code={option.code} />
              <span className="flex-1 truncate">{option.name}</span>
              {option.code === country.code && <Check className="h-3 w-3 text-primary" />}
            </button>
          ))}
        </div>
      )}

      <div className="relative min-w-0">
        <button
          type="button"
          title={selectedProvider ? `SIM provider: ${selectedProvider}` : "Choose SIM provider"}
          aria-label={selectedProvider ? `SIM provider ${selectedProvider}` : "Choose SIM provider"}
          onClick={() => setOpenMenu(openMenu === "provider" ? null : "provider")}
          className="flex h-7 max-w-[5.75rem] items-center gap-0.5 rounded bg-transparent px-1 text-[10px] font-medium text-foreground hover:bg-accent/50"
        >
          <span className="truncate">{selectedProvider ?? "SIM provider"}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      </div>

      {openMenu === "provider" && (
        <div
          className="absolute left-1/2 top-[calc(100%+4px)] z-40 max-h-[7.5rem] w-36 -translate-x-1/2 overflow-y-auto rounded-md border border-border bg-white p-1 text-black opacity-100 shadow-xl"
          style={{ backgroundColor: "#ffffff", opacity: 1 }}
        >
          {country.providers.map(provider => (
            <button
              key={provider}
              type="button"
              onClick={() => chooseProvider(provider)}
              className="relative flex h-6 w-full items-center justify-center rounded px-2 text-center text-[10px] text-black hover:bg-slate-100"
            >
              <span className="truncate">{provider}</span>
              {provider === selectedProvider && <Check className="absolute right-2 h-3 w-3 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountSlotCounter({
  active,
  total,
  centerX,
}: {
  active: number;
  total: number;
  centerX: number | null;
}) {
  return (
    <div
      style={{ left: centerX === null ? "82%" : `${centerX}px` }}
      className="absolute top-[calc(50%+1.15rem)] z-20 flex -translate-x-1/2 items-center gap-1 text-[11px] font-medium text-muted-foreground"
      aria-label={`${active} of ${total} account slots have Human Session Tool enabled`}
    >
      <UserRound className="h-3.5 w-3.5 shrink-0 text-green-500" aria-hidden="true" />
      <span className="text-black">{active}/{total}</span>
    </div>
  );
}

function makeTextLayer(): TextLayer {
  return {
    id: `txt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    text: 'Label', font: 'inter', size: 20, color: '#ffffff',
    x: 50, y: 50, bold: false, italic: false, shadow: true,
  };
}

// ─── Slot Customize Dialog ────────────────────────────────────────────────────

function CustomizePanel({
  open, onOpenChange, custom, onChange, label,
}: {
  open: boolean; onOpenChange: (v: boolean) => void;
  custom: SlotCustomization; onChange: (c: SlotCustomization) => void;
  label: string;
}) {
  const [tab, setTab] = useState<'wallpaper' | 'text'>('wallpaper');
  const [editId, setEditId] = useState<string | null>(null);
  const [pickingWallpaper, setPickingWallpaper] = useState(false);

  const updateLayer = (id: string, patch: Partial<TextLayer>) =>
    onChange({ ...custom, texts: custom.texts.map(t => t.id === id ? { ...t, ...patch } : t) });

  const addLayer = () => {
    const layer = makeTextLayer();
    onChange({ ...custom, texts: [...custom.texts, layer] });
    setEditId(layer.id);
    setTab('text');
  };

  const removeLayer = (id: string) => {
    onChange({ ...custom, texts: custom.texts.filter(t => t.id !== id) });
    if (editId === id) setEditId(null);
  };

  const browseWallpaper = async () => {
    setPickingWallpaper(true);
    try {
      const wallpaper = await pickLocalWallpaper();
      if (wallpaper) onChange({ ...custom, wallpaper });
    } finally {
      setPickingWallpaper(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Customise {label}</DialogTitle>
        </DialogHeader>

        <div className="flex border-b border-border -mt-1 mb-3">
          {(['wallpaper', 'text'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >{t === 'text' ? 'Text Layers' : 'Wallpaper'}</button>
          ))}
        </div>

        {tab === 'wallpaper' && (
          <div className="grid grid-cols-4 gap-2">
            <button
              type="button"
              onClick={browseWallpaper}
              disabled={pickingWallpaper}
              className={`relative aspect-[9/16] rounded-lg border-2 overflow-hidden transition-all ${
                custom.wallpaper?.startsWith('data:image/') ? 'border-primary ring-1 ring-primary/40' : 'border-border hover:border-muted-foreground'
              }`}
            >
              {custom.wallpaper?.startsWith('data:image/') ? (
                <img src={custom.wallpaper} className="w-full h-full object-cover" draggable={false} />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 bg-muted/30">
                  {pickingWallpaper ? <Loader2 className="w-4 h-4 animate-spin text-primary" /> : <ImagePlus className="w-4 h-4 text-primary" />}
                  <span className="text-[9px] text-muted-foreground font-medium px-1">Browse from PC</span>
                </div>
              )}
              <div className="absolute bottom-0 inset-x-0 bg-black/60 py-0.5 px-1 text-left">
                <span className="text-[8px] text-white/80 leading-none">From PC</span>
              </div>
              {custom.wallpaper?.startsWith('data:image/') && (
                <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-primary" />
              )}
            </button>
            <button
              type="button"
              onClick={() => onChange({ ...custom, wallpaper: null })}
              className={`relative aspect-[9/16] rounded-lg border-2 flex items-center justify-center bg-zinc-900 transition-all ${
                !custom.wallpaper ? 'border-primary ring-1 ring-primary/40' : 'border-border hover:border-muted-foreground'
              }`}
            >
              <span className="text-[10px] text-muted-foreground font-medium">None</span>
              {!custom.wallpaper && <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-primary" />}
            </button>
            {SLOT_WALLPAPERS.map(wp => (
              <button key={wp.id} type="button" onClick={() => onChange({ ...custom, wallpaper: wp.id })}
                className={`relative aspect-[9/16] rounded-lg border-2 overflow-hidden transition-all ${
                  custom.wallpaper === wp.id ? 'border-primary ring-1 ring-primary/40' : 'border-border hover:border-muted-foreground'
                }`}
              >
                <img src={`/wallpapers/${wp.id}`} className="w-full h-full object-cover" draggable={false} />
                <div className="absolute bottom-0 inset-x-0 bg-black/60 py-0.5 px-1 text-left">
                  <span className="text-[8px] text-white/80 leading-none">{wp.label}</span>
                </div>
                {custom.wallpaper === wp.id && <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-primary" />}
              </button>
            ))}
          </div>
        )}

        {tab === 'text' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{custom.texts.length} layer{custom.texts.length !== 1 ? 's' : ''}</span>
              <Button size="sm" variant="outline" onClick={addLayer} className="gap-1.5 h-7 text-xs">
                <Plus className="w-3 h-3" />Add Text
              </Button>
            </div>
            {custom.texts.length === 0 && (
              <div className="text-center py-8 text-sm text-muted-foreground">
                No text layers yet — click <strong>Add Text</strong> to get started.
              </div>
            )}
            {custom.texts.map(layer => (
              <div key={layer.id} className={`rounded-lg border transition-colors ${editId === layer.id ? 'border-primary/50 bg-muted/20' : 'border-border'}`}>
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className="flex-1 text-sm truncate cursor-pointer select-none"
                    style={{
                      fontFamily: SLOT_FONTS.find(f => f.id === layer.font)?.family,
                      color: layer.color,
                      fontWeight: layer.bold ? 'bold' : 'normal',
                      fontStyle: layer.italic ? 'italic' : 'normal',
                      textShadow: layer.shadow ? '0 1px 3px rgba(0,0,0,0.6)' : 'none',
                    }}
                    onClick={() => setEditId(editId === layer.id ? null : layer.id)}
                  >{layer.text || <span className="text-muted-foreground italic text-xs">empty</span>}</span>
                  <button onClick={() => setEditId(editId === layer.id ? null : layer.id)}
                    className="text-xs text-muted-foreground hover:text-foreground px-1 transition-colors"
                  >{editId === layer.id ? 'Done' : 'Edit'}</button>
                  <button onClick={() => removeLayer(layer.id)} className="text-muted-foreground hover:text-destructive transition-colors">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                {editId === layer.id && (
                  <div className="px-3 pb-3 space-y-3 border-t border-border/50 pt-3">
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Text</label>
                      <input className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                        value={layer.text} onChange={e => updateLayer(layer.id, { text: e.target.value })}
                        placeholder="Enter text…" autoFocus />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Font</label>
                        <select className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                          value={layer.font} onChange={e => updateLayer(layer.id, { font: e.target.value })}>
                          {SLOT_FONTS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Size — {layer.size}px</label>
                        <input type="range" min={8} max={72} value={layer.size}
                          onChange={e => updateLayer(layer.id, { size: Number(e.target.value) })}
                          className="w-full mt-2 accent-primary" />
                      </div>
                    </div>
                    <div className="flex items-end gap-5">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Colour</label>
                        <input type="color" value={layer.color}
                          onChange={e => updateLayer(layer.id, { color: e.target.value })}
                          className="w-10 h-8 rounded border border-border cursor-pointer bg-background block" />
                      </div>
                      {(['bold', 'italic', 'shadow'] as const).map(key => (
                        <label key={key} className="flex flex-col items-center gap-1 cursor-pointer">
                          <span className="text-xs text-muted-foreground capitalize">{key}</span>
                          <input type="checkbox" checked={layer[key]}
                            onChange={e => updateLayer(layer.id, { [key]: e.target.checked })}
                            className="accent-primary w-4 h-4" />
                        </label>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">X — {layer.x}%</label>
                        <input type="range" min={0} max={100} value={layer.x}
                          onChange={e => updateLayer(layer.id, { x: Number(e.target.value) })}
                          className="w-full accent-primary" />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Y — {layer.y}%</label>
                        <input type="range" min={0} max={100} value={layer.y}
                          onChange={e => updateLayer(layer.id, { y: Number(e.target.value) })}
                          className="w-full accent-primary" />
                      </div>
                    </div>
                    <div className="rounded bg-zinc-950 h-20 relative overflow-hidden border border-border/30">
                      <span className="absolute inset-0 flex items-center justify-center text-[9px] text-white/10 select-none">preview</span>
                      <div className="absolute pointer-events-none"
                        style={{
                          left: `${layer.x}%`, top: `${layer.y}%`,
                          transform: 'translate(-50%, -50%)',
                          fontFamily: SLOT_FONTS.find(f => f.id === layer.font)?.family,
                          fontSize: `${Math.min(layer.size, 28)}px`,
                          color: layer.color,
                          fontWeight: layer.bold ? 'bold' : 'normal',
                          fontStyle: layer.italic ? 'italic' : 'normal',
                          textShadow: layer.shadow ? '0 1px 6px rgba(0,0,0,0.9)' : 'none',
                          whiteSpace: 'pre', lineHeight: 1.2,
                        }}
                      >{layer.text || 'preview'}</div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── SVG icons ───────────────────────────────────────────────────────────────

function PhoneFarmIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
      {/* Rounded square background */}
      <rect x="1" y="1" width="22" height="22" rx="5"/>
      {/* Phone body — white */}
      <rect x="7.5" y="3.5" width="9" height="17" rx="2" fill="white"/>
      {/* Screen — currentColor (matches icon background colour) */}
      <rect x="9" y="5" width="6" height="12" rx="0.8"/>
      {/* Home button — white */}
      <rect x="10.5" y="18" width="3" height="1.2" rx="0.6" fill="white"/>
    </svg>
  );
}

/** Generic phone silhouette — brand-neutral */
function PhoneShell({
  className, online, active, wallpaperUrl, texts, uid = 'default', mirrorUrl,
}: {
  className?: string; online?: boolean; active?: boolean;
  wallpaperUrl?: string | null; texts?: TextLayer[]; uid?: string;
  mirrorUrl?: string | null;
}) {
  const glowId   = `glow-${uid}`;
  const sheenId  = `sheen-${uid}`;
  const clipId   = `screen-clip-${uid}`;
  return (
    <svg
      viewBox="0 0 220 440"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      fill="none"
    >
      <defs>
        <linearGradient id={sheenId} x1="12" y1="14" x2="208" y2="134" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff"/>
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0"/>
        </linearGradient>
        <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={online ? "#1AD2F2" : "#444"} stopOpacity={online ? "0.15" : "0.06"}/>
          <stop offset="100%" stopColor={online ? "#1AD2F2" : "#444"} stopOpacity="0"/>
        </radialGradient>
        {/* Clip path matches the screen rect exactly */}
        <clipPath id={clipId}>
          <rect x="12" y="14" width="196" height="412" rx="26"/>
        </clipPath>
      </defs>

      {/* Body */}
      <rect x="2" y="2" width="216" height="436" rx="34" fill="#1c1c1e" stroke="#3a3a3c" strokeWidth="2"/>
      <rect x="8" y="8" width="204" height="424" rx="29" fill="#111113" stroke="#2c2c2e" strokeWidth="1"/>
      {/* Screen background */}
      <rect x="12" y="14" width="196" height="412" rx="26" fill="#050508"/>

      {/* Wallpaper — rendered inside the screen rect, clipped to rounded corners */}
      {wallpaperUrl && (
        <image
          href={wallpaperUrl}
          x="12" y="14" width="196" height="412"
          preserveAspectRatio="xMidYMid slice"
          clipPath={`url(#${clipId})`}
        />
      )}

      {/* Text layers — rendered over wallpaper, clipped to screen */}
      {texts?.map(layer => {
        const tx = 12 + (layer.x / 100) * 196;
        const ty = 14 + (layer.y / 100) * 412;
        const font = SLOT_FONTS.find(f => f.id === layer.font);
        return (
          <text
            key={layer.id}
            x={tx} y={ty}
            textAnchor="middle"
            dominantBaseline="middle"
            clipPath={`url(#${clipId})`}
            fontFamily={font?.family}
            fontSize={layer.size}
            fill={layer.color}
            fontWeight={layer.bold ? 'bold' : 'normal'}
            fontStyle={layer.italic ? 'italic' : 'normal'}
            style={layer.shadow ? { filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.9))' } : undefined}
          >{layer.text}</text>
        );
      })}

      {/* Live mirror thumbnail — replaces wallpaper when phone mirror is open */}
      {mirrorUrl && (
        <image
          href={mirrorUrl}
          x="12" y="14" width="196" height="412"
          preserveAspectRatio="xMidYMid slice"
          clipPath={`url(#${clipId})`}
        />
      )}

      {/* Sheen / glass reflection over wallpaper */}
      <rect x="12" y="14" width="196" height="120" rx="26" fill={`url(#${sheenId})`} opacity="0.05"/>
      {/* Glow */}
      <ellipse cx="110" cy="220" rx="90" ry="130" fill={`url(#${glowId})`}/>

      {/* Punch-hole camera */}
      <circle cx="110" cy="36" r="5.5" fill="#000005"/>
      <circle cx="110" cy="36" r="3.5" fill="#0d1117"/>
      {/* Status bar */}
      <rect x="24" y="32" width="18" height="2" rx="1" fill="#2a2a35" opacity="0.6"/>
      <rect x="174" y="32" width="22" height="2" rx="1" fill="#2a2a35" opacity="0.6"/>
      {/* Home indicator */}
      <rect x="80" y="412" width="60" height="4" rx="2" fill="#3a3a45" opacity="0.7"/>
      {/* Side buttons */}
      <rect x="216" y="148" width="6" height="42" rx="3" fill="#2a2a30" stroke="#3a3a3c" strokeWidth="0.5"/>
      <rect x="-2" y="138" width="6" height="32" rx="3" fill="#2a2a30" stroke="#3a3a3c" strokeWidth="0.5"/>
      <rect x="-2" y="178" width="6" height="32" rx="3" fill="#2a2a30" stroke="#3a3a3c" strokeWidth="0.5"/>
    </svg>
  );
}


// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchFarmDevices(): Promise<FarmDevice[]> {
  const r = await fetch("/api/mobile/farm-devices");
  if (!r.ok) throw new Error("Failed to fetch farm devices");
  const d = await r.json();
  return d.devices as FarmDevice[];
}

interface UsbDiscoveryResponse {
  adbFound: boolean;
  adbPath?: string | null;
  phones: UsbPhone[];
  rawOutput?: string | null;
}

async function fetchUsbPhones(): Promise<UsbDiscoveryResponse> {
  const r = await fetch("/api/mobile/usb-phones");
  if (!r.ok) throw new Error(`USB discovery failed (${r.status})`);
  const d = await r.json();
  return {
    adbFound: d.adbFound === true,
    adbPath: typeof d.adbPath === "string" ? d.adbPath : null,
    phones: (d.phones ?? []) as UsbPhone[],
    rawOutput: typeof d.rawOutput === "string" ? d.rawOutput : null,
  };
}

async function registerDevice(phone: UsbPhone): Promise<FarmDevice> {
  const displayName = [phone.manufacturer, phone.marketName || MODEL_FRIENDLY_NAME[phone.model ?? ""] || phone.model].filter(Boolean).join(" ") || phone.serial;
  const r = await fetch("/api/mobile/farm-devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serial:         phone.serial,
      displayName,
      model:          phone.model ?? "",
      manufacturer:   phone.manufacturer ?? "",
      androidVersion: phone.androidVersion ?? "",
    }),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error ?? "Failed to register device");
  return d.device;
}

async function removeDevice(slotIndex: number): Promise<void> {
  const deviceResponse = await fetch("/api/mobile/farm-devices");
  const deviceData = deviceResponse.ok ? await deviceResponse.json().catch(() => null) : null;
  const device = (deviceData?.devices ?? []).find((entry: FarmDevice) => entry.slotIndex === slotIndex);
  if (device?.serial) {
    const stateResponse = await fetch(
      `/api/mobile/devices/${encodeURIComponent(device.serial)}/account-state`,
      { method: "DELETE" },
    );
    if (!stateResponse.ok) throw new Error("Failed to clear removed device account state");
  }
  const response = await fetch(`/api/mobile/farm-devices/${slotIndex}`, { method: "DELETE" });
  if (!response.ok) throw new Error("Failed to remove device");
}

// ─── Add Device Panel ─────────────────────────────────────────────────────────

function AddDevicePanel({
  registeredSerials,
  onAdded,
  onCancel,
}: {
  registeredSerials: Set<string>;
  onAdded: (device: FarmDevice) => void;
  onCancel: () => void;
}) {
  const [phones,  setPhones]  = useState<UsbPhone[]>([]);
  const [detectedCount, setDetectedCount] = useState(0);
  const [adbFound, setAdbFound] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding,  setAdding]  = useState<string | null>(null);
  const [installingAdb, setInstallingAdb] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const discovery = await fetchUsbPhones();
      setAdbFound(discovery.adbFound);
      setDetectedCount(discovery.phones.length);
      setPhones(discovery.phones.filter(p => !registeredSerials.has(p.serial)));
    } catch (e: any) {
      setError(e?.message ?? "USB discovery failed");
    }
    finally { setLoading(false); }
  }, [registeredSerials]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3_000);
    return () => clearInterval(id);
  }, [refresh]);

  const handleAdd = async (phone: UsbPhone) => {
    setAdding(phone.serial);
    setError(null);
    try {
      const device = await registerDevice(phone);
      onAdded(device);
    } catch (e: any) {
      setError(e?.message ?? "Registration failed");
    } finally {
      setAdding(null);
    }
  };

  const installAdb = async () => {
    setInstallingAdb(true);
    setError(null);
    try {
      const response = await fetch("/api/mobile/adb-auto-install", { method: "POST" });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error ?? "ADB setup failed");
      }
      await refresh();
    } catch (e: any) {
      setError(e?.message ?? "ADB setup failed");
    } finally {
      setInstallingAdb(false);
    }
  };

  const available = phones.filter(p => p.state === "device");
  const blocked   = phones.filter(p => p.state !== "device");

  return (
    <div className="h-full flex flex-col items-center justify-start pt-6 px-5 gap-4">
      {/* Header */}
      <div className="w-full flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-foreground">Add New Device</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Select a connected phone to assign to this slot</p>
        </div>
        <button
          onClick={onCancel}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded border border-border hover:border-border/80"
        >
          Cancel
        </button>
      </div>

      {error && (
        <div className="w-full bg-destructive/10 border border-destructive/30 rounded-xl px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : phones.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
          <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center">
            {adbFound === false
              ? <Download className="w-7 h-7 text-orange-400" />
              : <Usb className="w-7 h-7 text-muted-foreground" />}
          </div>
          <div>
            {adbFound === false ? (
              <>
                <p className="text-sm font-semibold text-foreground">ADB is not installed</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-[260px]">
                  Aura Farming cannot see USB phones until Windows ADB is set up.
                </p>
                <button
                  onClick={installAdb}
                  disabled={installingAdb}
                  className="mt-3 inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  {installingAdb ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                  {installingAdb ? "Downloading ADB…" : "Set up ADB automatically"}
                </button>
              </>
            ) : detectedCount > 0 ? (
              <>
                <p className="text-sm font-semibold text-foreground">All detected phones are already added</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-[240px]">
                  Disconnect an existing device or use the next available slot when another phone appears.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-foreground">No phones detected</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-[220px]">
                  Unlock the phone, choose File transfer over USB, and accept the USB debugging prompt.
                </p>
              </>
            )}
          </div>
          <button
            onClick={refresh}
            disabled={installingAdb}
            className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      ) : (
        <div className="w-full space-y-2">
          {/* Ready phones */}
          {available.map(phone => (
            <button
              key={phone.serial}
              onClick={() => handleAdd(phone)}
              disabled={adding !== null}
              className="w-full flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:border-primary/50 hover:bg-primary/5 transition-all text-left disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <div className="w-8 h-8 rounded-lg bg-green-500/10 border border-green-500/20 flex items-center justify-center shrink-0">
                <Wifi className="w-4 h-4 text-green-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-foreground truncate">
                  {[phone.manufacturer, phone.model].filter(Boolean).join(" ") || phone.serial}
                </p>
                <p className="text-[10px] text-muted-foreground truncate">{phone.serial}</p>
                {phone.androidVersion && (
                  <p className="text-[10px] text-muted-foreground">Android {phone.androidVersion}</p>
                )}
              </div>
              {adding === phone.serial ? (
                <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />
              ) : (
                <Plus className="w-4 h-4 text-primary shrink-0" />
              )}
            </button>
          ))}

          {/* Blocked/unauthorized phones */}
          {blocked.map(phone => (
            <div
              key={phone.serial}
              className="w-full flex items-center gap-3 p-3 rounded-xl border border-dashed border-border bg-card/50 opacity-60"
            >
              <div className="w-8 h-8 rounded-lg bg-orange-500/10 border border-orange-500/20 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-4 h-4 text-orange-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-foreground truncate">{phone.serial}</p>
                <p className="text-[10px] text-muted-foreground capitalize">{phone.state}</p>
              </div>
            </div>
          ))}

          <div className="flex items-center justify-end pt-1">
            <button
              onClick={refresh}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
          </div>
        </div>
      )}

      {/* Setup reminder */}
      <div className="w-full mt-auto bg-muted/40 border border-border/50 rounded-xl p-3 space-y-1.5">
        <p className="text-[10px] font-semibold text-muted-foreground">Phone not showing up?</p>
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Enable <strong className="text-foreground">USB Debugging</strong> in Settings → Developer Options, then allow the debug dialog on the phone.
        </p>
      </div>
    </div>
  );
}

// ─── Device Card ──────────────────────────────────────────────────────────────

function DeviceCard({
  device,
  phone,
  online,
  active,
  isStreaming,
  currentTool,
  accountSlotCount,
  activeHstSlotCount,
  onClick,
  onPower,
  powered,
  onRemove,
  custom,
  onCustomize,
}: {
  device:      FarmDevice;
  phone?:      UsbPhone;
  online:      boolean;
  active:      boolean;
  isStreaming: boolean;
  currentTool: string | null;
  accountSlotCount: number;
  activeHstSlotCount: number;
  onClick:     () => void;
  onPower:     () => void;
  powered:     boolean;
  onRemove:    () => void;
  custom:      SlotCustomization;
  onCustomize: (c: SlotCustomization) => void;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const phoneAreaRef = useRef<HTMLDivElement>(null);
  const phoneFrameRef = useRef<HTMLDivElement>(null);
  const [simCenterX, setSimCenterX] = useState<number | null>(null);

  useLayoutEffect(() => {
    const phoneArea = phoneAreaRef.current;
    const phoneFrame = phoneFrameRef.current;
    if (!phoneArea || !phoneFrame) return;

    const updateSimPosition = () => {
      const areaRect = phoneArea.getBoundingClientRect();
      const phoneRect = phoneFrame.getBoundingClientRect();
      const rightSpaceMidpoint = (phoneRect.right + areaRect.right) / 2 - areaRect.left;
      setSimCenterX(Math.max(0, Math.min(areaRect.width, rightSpaceMidpoint)));
    };

    updateSimPosition();
    const observer = new ResizeObserver(updateSimPosition);
    observer.observe(phoneArea);
    observer.observe(phoneFrame);
    return () => observer.disconnect();
  }, []);

  const handleRestart = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!device.serial || rebooting) return;
    setRebooting(true);
    sessionStorage.setItem("mobile-device-restart-requested", device.serial);
    window.dispatchEvent(new CustomEvent("mobile-device-graceful-restart", { detail: { serial: device.serial } }));
    const response = await fetch(`/api/mobile/devices/${encodeURIComponent(device.serial)}/graceful-reboot`, { method: "POST" }).catch(() => null);
    if (!response?.ok) {
      setRebooting(false);
      const result = await response?.json().catch(() => null);
      const message = result?.error ?? "Device restart failed";
      console.error("[PhoneFarm] device restart failed", message);
      // A reboot briefly makes ADB unavailable by design. Do not show the raw
      // Electron/ADB timeout in a blocking native alert; it is noisy, ugly,
      // and prevents the device page from recovering while the phone returns.
      // Keep the full error in the console for diagnostics and let the normal
      // device-status polling show the phone when it reconnects.
      return;
    }
    setTimeout(() => setRebooting(false), 15000);
  }, [device.serial, rebooting]);

  // ── Live mirror thumbnail ─────────────────────────────────────────────────
  // When the mirror is powered on (isStreaming), poll screencap.png every
  // 1.5 s and show the live screen inside the phone shell SVG. A screenshot
  // must load successfully and contain visible pixels before it replaces the
  // configured wallpaper/text. This is important because an asleep/off
  // device can return a valid but completely black PNG.
  const [mirrorTs, setMirrorTs] = useState<number | null>(null);
  const mirrorSerial = phone?.serial;
  useEffect(() => {
    let cancelled = false;
    let latestProbe = 0;
    if (!isStreaming || !mirrorSerial) {
      setMirrorTs(null);
      return () => { cancelled = true; };
    }

    const probe = () => {
      const timestamp = Date.now();
      const probeId = ++latestProbe;
      const image = new Image();
      image.onload = () => {
        if (cancelled || probeId !== latestProbe || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;

        // Sample a small grid instead of decoding the whole phone image into
        // React state. A real screen can be dark, but an entirely black/off
        // capture has no visible samples above this small threshold.
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          if (!cancelled && probeId === latestProbe) setMirrorTs(timestamp);
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let visibleSamples = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 12) {
            visibleSamples++;
          }
        }
        if (!cancelled && probeId === latestProbe) {
          setMirrorTs(visibleSamples > 0 ? timestamp : null);
        }
      };
      image.onerror = () => {
        if (!cancelled && probeId === latestProbe) setMirrorTs(null);
      };
      image.src = `/api/mobile/devices/${encodeURIComponent(mirrorSerial)}/screencap.png?t=${timestamp}`;
    };

    probe();
    const id = setInterval(probe, 1_500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isStreaming, mirrorSerial]);
  const mirrorUrl = mirrorTs && mirrorSerial
    ? `/api/mobile/devices/${encodeURIComponent(mirrorSerial)}/screencap.png?t=${mirrorTs}`
    : null;

  return (
    <div className="group h-full relative flex flex-col">
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onClick();
          }
        }}
        className={`flex-1 flex flex-col items-center gap-1.5 py-2 px-2 rounded-2xl border border-border bg-card transition-all duration-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40${active ? ' device-card-active' : ''}`}
      >
        {/* Phone shell — wallpaper and text rendered natively inside the SVG screen */}
        <div ref={phoneAreaRef} className="relative flex min-h-0 w-full flex-1 items-center justify-center">
          <div ref={phoneFrameRef} className="relative h-full max-w-full shrink-0 aspect-[1/2]">
            <PhoneShell
              className="absolute inset-0 h-full w-full group-hover:scale-[1.03] transition-transform duration-200"
              online={online}
              active={active}
              wallpaperUrl={custom.wallpaper
                ? (custom.wallpaper.startsWith('data:image/') ? custom.wallpaper : `/wallpapers/${custom.wallpaper}`)
                : null}
              texts={custom.texts}
              uid={String(device.slotIndex)}
              mirrorUrl={mirrorUrl}
            />
          </div>
          <SimCardSelector
            custom={custom}
            onChange={onCustomize}
            centerX={simCenterX}
          />
          <AccountSlotCounter
            active={Math.min(activeHstSlotCount, accountSlotCount)}
            total={accountSlotCount}
            centerX={simCenterX}
          />
        </div>

        <div className="h-5 shrink-0 flex items-center justify-center">
          {currentTool && (() => {
            const visual = toolVisual(currentTool);
            return (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-primary">
                {visual.icon}
                {visual.label}
              </span>
            );
          })()}
        </div>
        <div className="shrink-0 text-center space-y-0.5">
          <p className="text-base font-semibold text-foreground group-hover:text-primary transition-colors leading-tight">
            {resolveDisplayName(device, phone)}
          </p>
          <div className="flex items-center justify-center gap-1 mt-1 flex-wrap">
            {online ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                <span className="text-sm text-muted-foreground">Connected</span>
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 shrink-0" />
                <span className="text-sm text-muted-foreground">Offline</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Persistent device controls — kept in the top-right so they are
          discoverable without hovering over the card. */}
      <button
        onClick={handleRestart}
        disabled={rebooting}
        title="Restart device"
        aria-label="Restart device"
        className="absolute top-2 right-26 z-10 w-6 h-6 rounded-full bg-background border border-border flex items-center justify-center hover:bg-green-500/10 hover:border-green-500 hover:text-green-500 text-muted-foreground disabled:cursor-not-allowed"
      >
        <RotateCcw className={`w-3 h-3 ${rebooting ? "animate-spin" : ""}`} />
      </button>
      <button
        onClick={e => { e.stopPropagation(); onPower(); }}
        title={powered ? "Power off phone" : "Power on phone"}
        aria-label={powered ? "Power off phone" : "Power on phone"}
        className={`absolute top-2 right-18 z-10 w-6 h-6 rounded-full bg-background border border-border flex items-center justify-center hover:bg-primary/10 hover:border-primary/40 ${powered ? "text-emerald-500" : "text-muted-foreground hover:text-primary"}`}
      >
        <Power className="w-3 h-3" />
      </button>

      {/* Palette button */}
      <button
        onClick={e => { e.stopPropagation(); setPanelOpen(true); }}
        title="Customise wallpaper & text"
        className="absolute top-2 right-10 z-10 w-6 h-6 rounded-full bg-background border border-border flex items-center justify-center hover:bg-primary/10 hover:border-primary/40 hover:text-primary text-muted-foreground"
      >
        <Palette className="w-3 h-3" />
      </button>

      {/* Remove button */}
      <button
        onClick={e => { e.stopPropagation(); onRemove(); }}
        title="Remove device from farm"
        className="absolute top-2 right-2 z-10 w-6 h-6 rounded-full bg-background border border-border flex items-center justify-center hover:bg-destructive/10 hover:border-destructive/30 hover:text-destructive text-muted-foreground"
      >
        <Trash2 className="w-3 h-3" />
      </button>

      <CustomizePanel
        open={panelOpen}
        onOpenChange={setPanelOpen}
        custom={custom}
        onChange={onCustomize}
        label={resolveDisplayName(device, phone)}
      />
    </div>
  );
}

// ─── Add Device Card ──────────────────────────────────────────────────────────

function AddDeviceCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="h-full flex flex-col items-center justify-center gap-3 p-5 rounded-2xl border-2 border-dashed border-border/60 bg-card/20 hover:border-primary/50 hover:bg-primary/5 transition-all duration-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40 group"
    >
      <div className="w-14 h-14 rounded-2xl bg-muted/60 group-hover:bg-primary/10 flex items-center justify-center transition-colors">
        <Plus className="w-7 h-7 text-muted-foreground group-hover:text-primary transition-colors" />
      </div>
      <div className="text-center">
        <p className="text-sm font-semibold text-muted-foreground group-hover:text-foreground transition-colors">
          Add Device
        </p>
        <p className="text-[10px] text-muted-foreground/60 mt-0.5">Connect via USB</p>
      </div>
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function MobileDevicesPage() {
  const [, setLocation] = useLocation();

  const [devices,    setDevices]    = useState<FarmDevice[]>([]);
  const [loadingDb,  setLoadingDb]  = useState(true);
  const [addingSlot, setAddingSlot] = useState<number | null>(null);

  // ── Slot customizations — shared with MobilePage via same localStorage key
  const [slotCustom, setSlotCustom] = useState<Record<number, SlotCustomization>>(() => {
    try {
      const stored = localStorage.getItem('slot-customizations');
      return stored ? JSON.parse(stored) : {};
    } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem('slot-customizations', JSON.stringify(slotCustom)); }
    catch { /* quota exceeded */ }
  }, [slotCustom]);

  // Live USB status — polled every 2 s for the Connected/Offline badge.
  const [usbPhones, setUsbPhones] = useState<UsbPhone[]>([]);

  // Serials with an active automation cycle — polled every 2 s.
  const [activeCycleSerials, setActiveCycleSerials] = useState<Set<string>>(new Set());

  // Serials where the phone mirror is powered on — polled every 2 s.
  const [streamingSerials, setStreamingSerials] = useState<Set<string>>(new Set());
  const [manualPowerSerials, setManualPowerSerials] = useState<Set<string>>(new Set());
  const [currentTools, setCurrentTools] = useState<Map<string, string>>(new Map());
  const [accountSlotCounts, setAccountSlotCounts] = useState<Record<string, number>>({});
  const [activeHstSlotCounts, setActiveHstSlotCounts] = useState<Record<string, number>>({});

  const refreshDevices = useCallback(async () => {
    try {
      const d = await fetchFarmDevices();
      setDevices(previous => {
        if (previous.length > 0 && d.length === 0) {
          console.error(
            `[device-watchdog] farm device list dropped from ${previous.length} to 0; ` +
            "preserving the last known device list",
          );
          return previous;
        }
        return d;
      });
    } catch (error) {
      console.error("[device-watchdog] farm device refresh failed; preserving last known list", error);
    }
    finally { setLoadingDb(false); }
  }, []);

  const refreshSlotCounts = useCallback(async () => {
    const accountResults = await Promise.all(devices.map(async device => {
      try {
        const response = await fetch(`/api/mobile/devices/${encodeURIComponent(device.serial)}/account`);
        if (!response.ok) return null;
        const data = await response.json();
        return [device.serial, Array.isArray(data?.slots) ? data.slots.length : 0] as const;
      } catch {
        return null;
      }
    }));

    setAccountSlotCounts(previous => {
      const next = { ...previous };
      for (const result of accountResults) {
        if (result) next[result[0]] = result[1];
      }
      return next;
    });

    try {
      const response = await fetch("/api/mobile/enabled-hst-slots");
      if (!response.ok) return;
      const data = await response.json();
      const next: Record<string, number> = {};
      for (const slot of Array.isArray(data?.slots) ? data.slots : []) {
        if (typeof slot?.serial !== "string") continue;
        next[slot.serial] = (next[slot.serial] ?? 0) + 1;
      }
      setActiveHstSlotCounts(next);
    } catch {
      // Keep the last known active counts while the API is temporarily unavailable.
    }
  }, [devices]);

  useEffect(() => {
    void refreshSlotCounts();
    const id = setInterval(() => void refreshSlotCounts(), 3_000);
    return () => clearInterval(id);
  }, [refreshSlotCounts]);

  const refreshUsb = useCallback(async () => {
    try {
      const { phones } = await fetchUsbPhones();
      setUsbPhones(previous => {
        if (previous.length > 0 && phones.length === 0) {
          console.error(
            `[device-watchdog] USB device list dropped from ${previous.length} to 0; ` +
            "preserving the last known USB list",
          );
          return previous;
        }
        return phones;
      });
    } catch (error) {
      console.error("[device-watchdog] USB device refresh failed; preserving last known list", error);
    }
  }, []);

  const refreshCycleActive = useCallback(async () => {
    try {
      const r = await fetch("/api/mobile/cycle-active");
      if (r.ok) {
        const d = await r.json();
        setActiveCycleSerials(new Set(d.serials as string[]));
      }
    } catch { /* ignore — API server may be starting up */ }
  }, []);

  const refreshStreamActive = useCallback(async () => {
    try {
      const r = await fetch("/api/mobile/stream-active");
      if (r.ok) {
        const d = await r.json();
        setStreamingSerials(new Set(d.serials as string[]));
      }
    } catch { /* ignore */ }
  }, []);

  const toggleDevicePower = useCallback(async (serial: string) => {
    const powerOn = !manualPowerSerials.has(serial);
    setManualPowerSerials(previous => {
      const next = new Set(previous);
      if (powerOn) next.add(serial); else next.delete(serial);
      return next;
    });
    try {
      const response = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/input/key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: powerOn ? 224 : 223 }),
      });
      if (!response.ok) throw new Error("Power command failed");
    } catch {
      setManualPowerSerials(previous => {
        const next = new Set(previous);
        if (powerOn) next.delete(serial); else next.add(serial);
        return next;
      });
    }
  }, [manualPowerSerials]);

  const refreshCurrentTools = useCallback(async () => {
    const entries = await Promise.all([...activeCycleSerials].map(async serial => {
      const data = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/current-tool`)
        .then(r => r.ok ? r.json() : null).catch(() => null);
      return [serial, data?.tool] as const;
    }));
    setCurrentTools(new Map(entries.filter((entry): entry is readonly [string, string] => Boolean(entry[1]))));
  }, [activeCycleSerials]);

  useEffect(() => {
    refreshDevices();
    refreshUsb();
    refreshCycleActive();
    refreshStreamActive();
    const usbId      = setInterval(refreshUsb,          2_000);
    const cycleId    = setInterval(refreshCycleActive,  2_000);
    const streamId   = setInterval(refreshStreamActive, 2_000);
    return () => { clearInterval(usbId); clearInterval(cycleId); clearInterval(streamId); };
  }, [refreshDevices, refreshUsb, refreshCycleActive, refreshStreamActive]);

  useEffect(() => {
    void refreshCurrentTools();
    const id = setInterval(() => void refreshCurrentTools(), 2_000);
    return () => clearInterval(id);
  }, [refreshCurrentTools]);

  const onlineSerials = useMemo(
    () => new Set(usbPhones.filter(p => p.state === "device").map(p => p.serial)),
    [usbPhones],
  );

  const openDeviceMirror = useCallback(async (device: FarmDevice) => {
    const serial = device.serial;
    const started = performance.now();
    writeUiSpeedLog("device-card-clicked", {
      serial,
      slotIndex: device.slotIndex,
      online: onlineSerials.has(serial),
      startedAt: new Date().toISOString(),
    });
    sessionStorage.setItem("mobile_device_nav_started_at", String(started));
    sessionStorage.setItem("mobile_autopower_serial", serial);

    // Opening a device is an explicit request for its live mirror. The mirror
    // stream performs the conditional ensureScreenOn check after it connects:
    // an awake phone is left alone, while a sleeping phone is woken so the
    // mirror can produce frames. Do not send a standalone wake before the
    // mirror opens — that was waking the physical device without opening the
    // requested mirror yet.
    setLocation(`/mobile/farm/${encodeURIComponent(serial)}?autopower=1`);
  }, [onlineSerials, setLocation]);

  const registeredSerials = new Set(devices.map(d => d.serial));

  // Build the visible slots.
  // Registered devices occupy their persisted slot_index.
  // The next slot (maxSlot + 1) is the "Add Device" cell.
  // All slots beyond that are hidden.
  const maxSlot   = devices.length > 0 ? Math.max(...devices.map(d => d.slotIndex)) : 0;
  const addSlot   = maxSlot + 1;  // the "Add Device" cell index (1-based)
  const visibleUp = 6; // always show all 6 slots (2 rows × 3 columns)

  // slotMap: slot index → device (or null)
  const slotMap = new Map<number, FarmDevice>();
  for (const d of devices) slotMap.set(d.slotIndex, d);

  const handleRemove = async (slotIndex: number) => {
    await removeDevice(slotIndex).catch(() => {});
    setDevices(prev => prev.filter(d => d.slotIndex !== slotIndex));
    if (addingSlot === slotIndex) setAddingSlot(null);
  };

  const handleAdded = (device: FarmDevice) => {
    setDevices(prev => {
      const without = prev.filter(d => d.slotIndex !== device.slotIndex);
      return [...without, device].sort((a, b) => a.slotIndex - b.slotIndex);
    });
    setAddingSlot(null);
  };

  // Add Device is rendered as a floating panel so opening it never resizes or
  // reflows the device-card grid underneath.
  const showingAddPanel = addingSlot !== null;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="ml-[133px] flex-1 h-screen flex flex-col overflow-hidden">
        <LiveActivityTicker />
        {/* Header */}
        <div className="shrink-0 z-10 bg-background/95 backdrop-blur border-b border-border px-6 py-3 flex items-center justify-center gap-3">
          <PhoneFarmIcon className="w-5 h-5" style={{ color: "#1AD2F2" }} />
          <h1 className="text-lg font-bold text-foreground">Phone Farm - Manage Your Devices</h1>
        </div>

        {loadingDb ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex-1 overflow-hidden p-6 flex gap-4">
            {/* Device grid — only visible slots rendered */}
            <div
              className="flex-1 grid gap-4"
              style={{
                gridTemplateColumns: "repeat(3, 1fr)",
                gridTemplateRows:    "repeat(2, 1fr)",
              }}
            >
              {Array.from({ length: visibleUp }).map((_, i) => {
                const slotIndex = i + 1;
                const device    = slotMap.get(slotIndex) ?? null;

                if (device) {
                  const livePhone = usbPhones.find(p => p.serial === device.serial);
                  return (
                    <DeviceCard
                      key={device.serial}
                      device={device}
                      phone={livePhone}
                      online={onlineSerials.has(device.serial)}
                      active={activeCycleSerials.has(device.serial) && onlineSerials.has(device.serial)}
                      isStreaming={streamingSerials.has(device.serial) || (activeCycleSerials.has(device.serial) && onlineSerials.has(device.serial))}
                      currentTool={currentTools.get(device.serial) ?? null}
                      accountSlotCount={accountSlotCounts[device.serial] ?? 0}
                      activeHstSlotCount={activeHstSlotCounts[device.serial] ?? 0}
                       onClick={() => void openDeviceMirror(device)}
                       powered={manualPowerSerials.has(device.serial) || streamingSerials.has(device.serial)}
                       onPower={() => void toggleDevicePower(device.serial)}
                      onRemove={() => handleRemove(device.slotIndex)}
                      custom={slotCustom[device.slotIndex] ?? DEFAULT_SLOT_CUSTOM}
                      onCustomize={c => setSlotCustom(prev => ({ ...prev, [device.slotIndex]: c }))}
                    />
                  );
                }

                // "Add Device" slot
                if (slotIndex === addSlot) {
                  return (
                    <AddDeviceCard
                      key="add"
                      onClick={() => setAddingSlot(slotIndex)}
                    />
                  );
                }
                return <div key={`empty-${slotIndex}`} />;
              })}
            </div>

            {/* Add Device popup — floats above the unchanged device grid */}
            {showingAddPanel && (
              <div className="fixed right-6 top-[4.5rem] z-50 h-[calc(100vh-6rem)] w-[360px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-border bg-card shadow-2xl shadow-black/30">
                <AddDevicePanel
                  registeredSerials={registeredSerials}
                  onAdded={handleAdded}
                  onCancel={() => setAddingSlot(null)}
                />
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
