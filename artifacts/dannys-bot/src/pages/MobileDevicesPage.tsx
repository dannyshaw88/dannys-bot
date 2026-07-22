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

import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { Sidebar } from "@/components/layout/Sidebar";
import { LiveActivityTicker } from "@/components/layout/LiveActivityTicker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Usb, Plus, Wifi, WifiOff, AlertTriangle, Trash2, RefreshCw, Palette, X } from "lucide-react";

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

interface SlotCustomization { wallpaper: string | null; texts: TextLayer[]; }
const DEFAULT_SLOT_CUSTOM: SlotCustomization = { wallpaper: null, texts: [] };

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
              onClick={() => onChange({ ...custom, wallpaper: null })}
              className={`relative aspect-[9/16] rounded-lg border-2 flex items-center justify-center bg-zinc-900 transition-all ${
                !custom.wallpaper ? 'border-primary ring-1 ring-primary/40' : 'border-border hover:border-muted-foreground'
              }`}
            >
              <span className="text-[10px] text-muted-foreground font-medium">None</span>
              {!custom.wallpaper && <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-primary" />}
            </button>
            {SLOT_WALLPAPERS.map(wp => (
              <button key={wp.id} onClick={() => onChange({ ...custom, wallpaper: wp.id })}
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

async function fetchUsbPhones(): Promise<UsbPhone[]> {
  const r = await fetch("/api/mobile/usb-phones");
  if (!r.ok) return [];
  const d = await r.json();
  return (d.phones ?? []) as UsbPhone[];
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
  await fetch(`/api/mobile/farm-devices/${slotIndex}`, { method: "DELETE" });
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
  const [loading, setLoading] = useState(true);
  const [adding,  setAdding]  = useState<string | null>(null);
  const [error,   setError]   = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await fetchUsbPhones();
      setPhones(all.filter(p => !registeredSerials.has(p.serial)));
    } catch { /* ignore */ }
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
            <Usb className="w-7 h-7 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">No phones detected</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-[220px]">
              Plug in an Android phone with USB Debugging enabled
            </p>
          </div>
          <button
            onClick={refresh}
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
  onClick,
  onRemove,
  custom,
  onCustomize,
}: {
  device:      FarmDevice;
  phone?:      UsbPhone;
  online:      boolean;
  active:      boolean;
  isStreaming: boolean;
  onClick:     () => void;
  onRemove:    () => void;
  custom:      SlotCustomization;
  onCustomize: (c: SlotCustomization) => void;
}) {
  const [panelOpen, setPanelOpen] = useState(false);

  // ── Live mirror thumbnail ─────────────────────────────────────────────────
  // When the mirror is powered on (isStreaming), poll screencap.png every
  // 1.5 s and show the live screen inside the phone shell SVG.
  const [mirrorTs, setMirrorTs] = useState<number | null>(null);
  const mirrorSerial = phone?.serial;
  useEffect(() => {
    if (!isStreaming || !mirrorSerial) { setMirrorTs(null); return; }
    setMirrorTs(Date.now());
    const id = setInterval(() => setMirrorTs(Date.now()), 1_500);
    return () => clearInterval(id);
  }, [isStreaming, mirrorSerial]);
  const mirrorUrl = mirrorTs && mirrorSerial
    ? `/api/mobile/devices/${encodeURIComponent(mirrorSerial)}/screencap.png?t=${mirrorTs}`
    : null;

  return (
    <div className="group h-full relative flex flex-col">
      <button
        onClick={onClick}
        className={`flex-1 flex flex-col items-center gap-1.5 py-2 px-2 rounded-2xl border border-border bg-card hover:border-primary/50 hover:bg-card/80 transition-all duration-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40${active ? ' device-card-active' : ''}`}
      >
        {/* Phone shell — wallpaper and text rendered natively inside the SVG screen */}
        <PhoneShell
          className="flex-1 min-h-0 w-auto max-w-[150px] group-hover:scale-[1.03] transition-transform duration-200"
          online={online}
          active={active}
          wallpaperUrl={custom.wallpaper ? `/wallpapers/${custom.wallpaper}` : null}
          texts={custom.texts}
          uid={String(device.slotIndex)}
          mirrorUrl={mirrorUrl}
        />

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
            <span className="text-sm text-muted-foreground/30 select-none">|</span>
            {active ? (
              <span className="text-sm font-semibold text-green-400">Active</span>
            ) : (
              <span className="text-sm text-muted-foreground/60">Not Active</span>
            )}
          </div>
        </div>
      </button>

      {/* Palette button — appears on hover */}
      <button
        onClick={e => { e.stopPropagation(); setPanelOpen(true); }}
        title="Customise wallpaper & text"
        className="absolute top-2 left-2 w-6 h-6 rounded-full bg-background border border-border flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-primary/10 hover:border-primary/40 hover:text-primary text-muted-foreground"
      >
        <Palette className="w-3 h-3" />
      </button>

      {/* Remove button — appears on hover */}
      <button
        onClick={e => { e.stopPropagation(); onRemove(); }}
        title="Remove device from farm"
        className="absolute top-2 right-2 w-6 h-6 rounded-full bg-background border border-border flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/10 hover:border-destructive/30 hover:text-destructive text-muted-foreground"
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

  const refreshDevices = useCallback(async () => {
    try {
      const d = await fetchFarmDevices();
      setDevices(d);
    } catch { /* ignore */ }
    finally { setLoadingDb(false); }
  }, []);

  const refreshUsb = useCallback(async () => {
    const p = await fetchUsbPhones().catch(() => []);
    setUsbPhones(p);
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

  const onlineSerials = new Set(
    usbPhones.filter(p => p.state === "device").map(p => p.serial)
  );

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

  // When "Add Device" is showing in a panel, the grid itself is not shown for
  // that slot — instead we show the panel full-width alongside the existing
  // device cards. For simplicity: show the panel as an overlay column.
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
                // If add panel open, shrink the grid to make room
                maxWidth: showingAddPanel ? "55%" : "100%",
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
                      isStreaming={streamingSerials.has(device.serial)}
                      onClick={() => setLocation(`/mobile/farm/${encodeURIComponent(device.serial)}`)}
                      onRemove={() => handleRemove(device.slotIndex)}
                      custom={slotCustom[device.slotIndex] ?? DEFAULT_SLOT_CUSTOM}
                      onCustomize={c => setSlotCustom(prev => ({ ...prev, [device.slotIndex]: c }))}
                    />
                  );
                }

                // "Add Device" slot
                if (slotIndex === addSlot && !showingAddPanel) {
                  return (
                    <AddDeviceCard
                      key="add"
                      onClick={() => setAddingSlot(slotIndex)}
                    />
                  );
                }

                // Placeholder while add panel is open for this slot
                return (
                  <div
                    key={`placeholder-${slotIndex}`}
                    className="h-full rounded-2xl border-2 border-dashed border-border/20 bg-card/10"
                  />
                );
              })}
            </div>

            {/* Add Device panel — slides in on the right */}
            {showingAddPanel && (
              <div className="w-[320px] shrink-0 rounded-2xl border border-border bg-card overflow-y-auto">
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
