import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";

type FarmDevice = {
  serial: string;
  slotIndex?: number;
  displayName?: string;
  model?: string;
  marketName?: string;
  manufacturer?: string;
};

type AccountSlot = {
  slotId?: string;
  platform?: "instagram" | "snapchat";
  username?: string;
  password?: string;
  totpSecret?: string;
  emailAddress?: string;
  emailPassword?: string;
  phoneNumber?: string;
  snapchatTrustScoreLabel?: string;
};

type DeviceAccount = {
  slots?: AccountSlot[];
};

type DeviceListResponse = { phones?: FarmDevice[] };
type FarmDeviceListResponse = { devices?: FarmDevice[] };

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  // Prevent spreadsheet formula execution for values originating in account data.
  if (/^[\u0000-\u0020]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, rows: unknown[][]) {
  const csv = `\uFEFF${rows.map(row => row.map(csvCell).join(",")).join("\r\n")}`;
  const blobUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(blobUrl);
}

export function FarmAccountsExportPanel() {
  const { toast } = useToast();
  const [selectedSerial, setSelectedSerial] = useState("");
  const [selectedSlotKeys, setSelectedSlotKeys] = useState<Set<string>>(() => new Set());

  const phonesQuery = useQuery<DeviceListResponse>({
    queryKey: ["/api/mobile/usb-phones"],
    queryFn: async () => {
      const response = await fetch("/api/mobile/usb-phones", { credentials: "include" });
      if (!response.ok) throw new Error("Could not load devices");
      return response.json();
    },
    refetchInterval: 15_000,
  });

  const farmDevicesQuery = useQuery<FarmDeviceListResponse>({
    queryKey: ["/api/mobile/farm-devices"],
    queryFn: async () => {
      const response = await fetch("/api/mobile/farm-devices", { credentials: "include" });
      if (!response.ok) throw new Error("Could not load Phone Farm devices");
      return response.json();
    },
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const devices = useMemo(() => {
    const bySerial = new Map<string, FarmDevice>();
    for (const device of farmDevicesQuery.data?.devices ?? []) {
      bySerial.set(device.serial, device);
    }
    for (const phone of phonesQuery.data?.phones ?? []) {
      const saved = bySerial.get(phone.serial);
      bySerial.set(phone.serial, saved ? { ...phone, ...saved, marketName: phone.marketName } : phone);
    }
    return [...bySerial.values()].sort((a, b) => {
      const slotA = Number.isFinite(a.slotIndex) ? Number(a.slotIndex) : Number.POSITIVE_INFINITY;
      const slotB = Number.isFinite(b.slotIndex) ? Number(b.slotIndex) : Number.POSITIVE_INFINITY;
      return slotA - slotB;
    });
  }, [farmDevicesQuery.data, phonesQuery.data]);

  useEffect(() => {
    if (!devices.length) {
      if (selectedSerial) setSelectedSerial("");
      return;
    }
    if (!devices.some(device => device.serial === selectedSerial)) {
      setSelectedSerial(devices[0].serial);
      setSelectedSlotKeys(new Set());
    }
  }, [devices, selectedSerial]);

  const accountQuery = useQuery<DeviceAccount>({
    queryKey: ["/api/mobile/devices", selectedSerial, "account"],
    queryFn: async () => {
      const response = await fetch(
        `/api/mobile/devices/${encodeURIComponent(selectedSerial)}/account`,
        { credentials: "include", cache: "no-store" },
      );
      if (!response.ok) throw new Error("Could not load account slots");
      return response.json();
    },
    enabled: Boolean(selectedSerial),
    staleTime: 0,
  });

  const accountSlots = useMemo(() => {
    return (accountQuery.data?.slots ?? [])
      .map((slot, index) => ({
        slot,
        slotNumber: index + 1,
        key: slot.slotId || `slot-${index + 1}`,
        platform: slot.platform === "snapchat" ? "snapchat" as const : "instagram" as const,
      }))
      .filter(({ slot }) => Boolean(slot.username?.trim()));
  }, [accountQuery.data]);

  const selectedDevice = devices.find(device => device.serial === selectedSerial);
  const selectedAccountSlots = accountSlots.filter(account => selectedSlotKeys.has(account.key));
  const selectedCount = selectedAccountSlots.length;
  const allSelected = accountSlots.length > 0 && selectedCount === accountSlots.length;

  const toggleAll = (checked: boolean | "indeterminate") => {
    setSelectedSlotKeys(checked === true
      ? new Set(accountSlots.map(account => account.key))
      : new Set());
  };

  const toggleSlot = (key: string, checked: boolean | "indeterminate") => {
    setSelectedSlotKeys(current => {
      const next = new Set(current);
      if (checked === true) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const exportAccounts = () => {
    if (!selectedDevice || selectedCount === 0 || accountQuery.isLoading || accountQuery.isError) return;
    const deviceName = selectedDevice.displayName || selectedDevice.marketName || selectedDevice.model || selectedDevice.serial;
    const rows: unknown[][] = [
      [
        "Device",
        "Device Serial",
        "Platform",
        "Account Slot",
        "Username",
        "Password",
        "2FA Secret",
        "Email Address",
        "Email Password",
        "Phone Number",
        "Snapchat Trust Score",
      ],
      ...selectedAccountSlots.map(({ slot, slotNumber, platform: slotPlatform }) => [
        deviceName,
        selectedDevice.serial,
        slotPlatform === "snapchat" ? "Snapchat" : "Instagram",
        slotNumber,
        slot.username,
        slot.password,
        slot.totpSecret,
        slot.emailAddress,
        slot.emailPassword,
        slot.phoneNumber,
        slotPlatform === "snapchat" ? slot.snapchatTrustScoreLabel : "",
      ]),
    ];
    const safeSerial = selectedDevice.serial.replace(/[^a-zA-Z0-9_-]/g, "_");
    downloadCsv(
      `account-slots-${safeSerial}-${new Date().toISOString().slice(0, 10)}.csv`,
      rows,
    );
    toast({
      title: "Account CSV downloaded",
      description: `${selectedCount} account slot${selectedCount === 1 ? "" : "s"} exported.`,
    });
  };

  const deviceLoadError = phonesQuery.isError && farmDevicesQuery.isError;

  return (
    <section className="desktop-card p-6 space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Export Account Slots</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose a device, then select individual account slots or select them all.
        </p>
      </div>

      {deviceLoadError ? (
        <p role="alert" className="text-sm text-destructive">Could not load device list. Refresh the page and try again.</p>
      ) : devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">No farm or connected devices are available.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Device</span>
            <select
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={selectedSerial}
              onChange={event => {
                setSelectedSerial(event.target.value);
                setSelectedSlotKeys(new Set());
              }}
            >
              {devices.map(device => {
                const name = device.displayName || device.marketName || device.model || device.manufacturer || "Phone";
                const label = device.slotIndex
                  ? `Device ${device.slotIndex} — ${name} (${device.serial})`
                  : `${name} (${device.serial})`;
                return <option key={device.serial} value={device.serial}>{label}</option>;
              })}
            </select>
          </label>
        </div>
      )}

      {selectedSerial && !accountQuery.isError && (
        <div className="overflow-hidden rounded-lg border border-border">
          <label className="flex cursor-pointer items-center gap-3 border-b border-border bg-muted/30 px-4 py-3">
            <Checkbox
              checked={allSelected ? true : selectedCount > 0 ? "indeterminate" : false}
              onCheckedChange={toggleAll}
              disabled={accountQuery.isLoading || accountSlots.length === 0}
              aria-label="Select all account slots"
            />
            <span className="text-sm font-semibold">Select all</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {accountQuery.isLoading ? "Loading slots…" : `${selectedCount} of ${accountSlots.length} selected`}
            </span>
          </label>
          {accountQuery.isLoading ? (
            <div className="flex items-center gap-2 px-4 py-5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />Loading account slots…
            </div>
          ) : accountSlots.length === 0 ? (
            <p className="px-4 py-5 text-sm text-muted-foreground">No populated account slots on this device.</p>
          ) : (
            <div className="max-h-80 divide-y divide-border overflow-y-auto">
              {accountSlots.map(({ slot, slotNumber, key, platform: slotPlatform }) => (
                <label key={key} className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-accent/30">
                  <Checkbox
                    checked={selectedSlotKeys.has(key)}
                    onCheckedChange={checked => toggleSlot(key, checked)}
                    aria-label={`Select ${slot.username} in slot ${slotNumber}`}
                  />
                  <span className="w-16 shrink-0 text-xs text-muted-foreground">Slot {slotNumber}</span>
                  <span className="rounded border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {slotPlatform}
                  </span>
                  <span className="min-w-0 truncate text-sm font-medium">@{slot.username}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {accountQuery.isError && selectedSerial && (
        <p role="alert" className="text-sm text-destructive">Could not load this device’s account slots.</p>
      )}

      <Button
        type="button"
        onClick={exportAccounts}
        disabled={!selectedSerial || accountQuery.isLoading || accountQuery.isError || selectedCount === 0}
      >
        {accountQuery.isLoading
          ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading</>
          : <><Download className="mr-2 h-4 w-4" />Export {selectedCount || ""} Selected to CSV</>}
      </Button>

      <p className="border-t border-border pt-4 text-xs text-muted-foreground">
        The CSV contains account login details, including passwords and 2FA/email credentials. Store the file securely.
      </p>
    </section>
  );
}
