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

import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Sidebar } from "@/components/layout/Sidebar";
import { Loader2, Usb, Plus, Wifi, WifiOff, AlertTriangle, Trash2, RefreshCw } from "lucide-react";

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
  manufacturer?:   string;
  androidVersion?: string;
}

// ─── SVG icons ───────────────────────────────────────────────────────────────

function PhoneFarmIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
      <rect x="0.5" y="8.5" width="4" height="1.6" rx="0.8"/>
      <rect x="0.5" y="11.5" width="3" height="1.6" rx="0.8"/>
      <rect x="5" y="1" width="11" height="19" rx="2"/>
      <rect x="6.5" y="3" width="8" height="13" rx="1" fill="var(--background,#0f172a)"/>
      <circle cx="10.5" cy="18" r="1" fill="var(--background,#0f172a)"/>
      <path d="M17,10.5 L17.8,11.61 L19.17,11.75 L18.6,13 L19.17,14.25 L17.8,14.39 L17,15.5 L16.2,14.39 L14.84,14.25 L15.4,13 L14.84,11.75 L16.2,11.61Z"/>
      <circle cx="17" cy="13" r="1.1" fill="var(--background,#0f172a)"/>
    </svg>
  );
}

/** Generic phone silhouette — brand-neutral */
function PhoneShell({ className, online }: { className?: string; online?: boolean }) {
  return (
    <svg
      viewBox="0 0 220 440"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      fill="none"
    >
      <defs>
        <linearGradient id="wallpaper" x1="12" y1="14" x2="208" y2="426" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#0f1824"/>
          <stop offset="100%" stopColor="#071218"/>
        </linearGradient>
        <linearGradient id="sheen" x1="12" y1="14" x2="208" y2="134" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff"/>
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0"/>
        </linearGradient>
        <radialGradient id={online ? "glow-on" : "glow-off"} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={online ? "#1AD2F2" : "#444"} stopOpacity={online ? "0.15" : "0.06"}/>
          <stop offset="100%" stopColor={online ? "#1AD2F2" : "#444"} stopOpacity="0"/>
        </radialGradient>
      </defs>
      {/* Body */}
      <rect x="2" y="2" width="216" height="436" rx="34" fill="#1c1c1e" stroke="#3a3a3c" strokeWidth="2"/>
      <rect x="8" y="8" width="204" height="424" rx="29" fill="#111113" stroke="#2c2c2e" strokeWidth="1"/>
      <rect x="12" y="14" width="196" height="412" rx="26" fill="url(#wallpaper)"/>
      <rect x="12" y="14" width="196" height="120" rx="26" fill="url(#sheen)" opacity="0.07"/>
      {/* Glow */}
      <ellipse cx="110" cy="220" rx="90" ry="130" fill={`url(#${online ? "glow-on" : "glow-off"})`}/>
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
      {/* Cyan accent */}
      <rect x="90" y="272" width="40" height="2" rx="1" fill="#1AD2F2" opacity={online ? "0.7" : "0.2"}/>
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
  const displayName = [phone.manufacturer, phone.model].filter(Boolean).join(" ") || phone.serial;
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
  online,
  onClick,
  onRemove,
}: {
  device:   FarmDevice;
  online:   boolean;
  onClick:  () => void;
  onRemove: () => void;
}) {
  return (
    <div className="group h-full relative flex flex-col">
      <button
        onClick={onClick}
        className="flex-1 flex flex-col items-center gap-2 py-4 px-3 rounded-2xl border border-border bg-card hover:border-primary/50 hover:bg-card/80 transition-all duration-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        <PhoneShell
          className="flex-1 min-h-0 w-auto max-w-[110px] drop-shadow-lg group-hover:scale-[1.03] transition-transform duration-200"
          online={online}
        />
        <div className="shrink-0 text-center space-y-0.5">
          <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors leading-tight">
            {device.displayName || device.serial}
          </p>
          {device.model && device.displayName !== device.model && (
            <p className="text-xs text-muted-foreground">{device.model}</p>
          )}
          <div className="flex items-center justify-center gap-1.5 mt-1">
            {online ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                <span className="text-[10px] text-muted-foreground">Connected</span>
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 shrink-0" />
                <span className="text-[10px] text-muted-foreground">Offline</span>
              </>
            )}
          </div>
        </div>
      </button>

      {/* Remove button — appears on hover */}
      <button
        onClick={e => { e.stopPropagation(); onRemove(); }}
        title="Remove device from farm"
        className="absolute top-2 right-2 w-6 h-6 rounded-full bg-background border border-border flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/10 hover:border-destructive/30 hover:text-destructive text-muted-foreground"
      >
        <Trash2 className="w-3 h-3" />
      </button>
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
  const [addingSlot, setAddingSlot] = useState<number | null>(null); // slot currently showing the add panel

  // Live USB status — polled only for "online" badge, not for the grid itself
  const [usbPhones, setUsbPhones] = useState<UsbPhone[]>([]);

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

  useEffect(() => {
    refreshDevices();
    refreshUsb();
    const id = setInterval(refreshUsb, 4_000);
    return () => clearInterval(id);
  }, [refreshDevices, refreshUsb]);

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
  const visibleUp = Math.min(addSlot, 6); // never exceed 6 slots

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
        {/* Header */}
        <div className="shrink-0 z-10 bg-background/95 backdrop-blur border-b border-border px-6 py-3 flex items-center gap-3">
          <PhoneFarmIcon className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-bold text-foreground">Phone Farm</h1>
          <span className="text-xs text-muted-foreground ml-1">
            {devices.length} device{devices.length !== 1 ? "s" : ""} registered
          </span>
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
                gridTemplateRows:    visibleUp <= 3 ? "1fr" : "repeat(2, 1fr)",
                // If add panel open, shrink the grid to make room
                maxWidth: showingAddPanel ? "55%" : "100%",
              }}
            >
              {Array.from({ length: visibleUp }).map((_, i) => {
                const slotIndex = i + 1;
                const device    = slotMap.get(slotIndex) ?? null;

                if (device) {
                  return (
                    <DeviceCard
                      key={device.serial}
                      device={device}
                      online={onlineSerials.has(device.serial)}
                      onClick={() => setLocation(`/mobile/farm/${encodeURIComponent(device.serial)}`)}
                      onRemove={() => handleRemove(device.slotIndex)}
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
