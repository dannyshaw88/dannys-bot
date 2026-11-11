import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, ShieldCheck, Wifi } from "lucide-react";

export type FarmProxyOption = {
  id: number;
  name?: string | null;
  host: string;
  port: number;
  proxyType?: string | null;
  adapterName?: string | null;
};

type Props = {
  serial: string;
  online: boolean;
  loading: boolean;
  proxyId: number | null | undefined;
  proxies: FarmProxyOption[];
  proxyConfigError?: string | null;
  onProxyIdChange: (serial: string, proxyId: number | null) => void;
};

async function readJson(response: Response): Promise<any> {
  return response.json().catch(() => null);
}

export function FarmDeviceProxyControl({
  serial,
  online,
  loading,
  proxyId,
  proxies,
  proxyConfigError,
  onProxyIdChange,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const handledAssignment = useRef<number | null | undefined>(undefined);
  const handledOnline = useRef(false);
  const selectedProxy = proxies.find(proxy => proxy.id === proxyId);
  const selectedLabel = selectedProxy
    ? selectedProxy.proxyType === "adapter"
      ? `Adapter: ${selectedProxy.adapterName || selectedProxy.name || "network"}`
      : `${selectedProxy.name || `${selectedProxy.host}:${selectedProxy.port}`} (${selectedProxy.proxyType === "socks5" ? "SOCKS5" : "HTTP"})`
    : "Device default connection";

  const applySavedAssignment = useCallback(async (showProgress: boolean, force = false) => {
    if (!online) {
      setStatus(proxyId == null ? "Using device default when connected" : "Saved; applies when connected");
      setFailed(false);
      return;
    }

    if (showProgress) {
      setBusy(true);
      setStatus("Applying network route…");
      setFailed(false);
    }
    try {
      if (!force) {
        const statusResponse = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/proxy-status`);
        const current = await readJson(statusResponse);
        if (statusResponse.ok) {
          const matches = proxyId == null
            ? !current?.deviceProxy && !current?.relayActive
            : current?.proxyId === proxyId &&
              current?.relayActive === true &&
              current?.adbReverseActive === true &&
              Boolean(current?.deviceProxy) &&
              (selectedProxy?.proxyType === "adapter"
                ? current?.upstreamProxy === `adapter:${selectedProxy.adapterName ?? "unknown"}`
                : current?.upstreamProxy === `${selectedProxy?.host}:${selectedProxy?.port}`);
          if (matches) {
            setStatus(proxyId == null ? "Using device default connection" : `Applied: ${selectedLabel}`);
            setFailed(false);
            return;
          }
        }
      }
      const response = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/apply-proxy`, {
        method: "POST",
      });
      const result = await readJson(response);
      if (!response.ok || result?.ok !== true) {
        throw new Error(result?.error ?? `Could not apply the device proxy (${response.status})`);
      }
      setStatus(result.message ?? (proxyId == null ? "Using device default connection" : "Proxy applied"));
      setFailed(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not apply the device proxy");
      setFailed(true);
    } finally {
      if (showProgress) setBusy(false);
    }
  }, [online, proxyId, selectedLabel, selectedProxy, serial]);

  useEffect(() => {
    if (loading || proxyId === undefined) return;
    if (!online) {
      handledOnline.current = false;
      setStatus(proxyId == null ? "Using device default when connected" : "Saved; applies when connected");
      setFailed(false);
      return;
    }
    if (handledAssignment.current === proxyId && handledOnline.current) return;
    handledAssignment.current = proxyId;
    handledOnline.current = true;
    void applySavedAssignment(false);
  }, [applySavedAssignment, loading, online, proxyId]);

  const handleSelection = async (value: string) => {
    const nextProxyId = value ? Number(value) : null;
    if (nextProxyId !== null && !Number.isInteger(nextProxyId)) return;
    setBusy(true);
    setStatus(online ? "Saving and applying…": "Saving for next connection…");
    setFailed(false);
    try {
      const response = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyId: nextProxyId }),
      });
      const result = await readJson(response);
      if (!response.ok || result?.ok !== true) {
        throw new Error(result?.error ?? `Could not save the device proxy (${response.status})`);
      }

      onProxyIdChange(serial, nextProxyId);
      handledAssignment.current = nextProxyId;
      handledOnline.current = online;
      setStatus(result.warning ?? result.message ?? "Proxy assignment saved");
      setFailed(Boolean(result.warning));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save the device proxy");
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const currentProxyExists = proxyId == null || proxies.some(proxy => proxy.id === proxyId);

  return (
    <div
      className="shrink-0 px-3 pb-2"
      data-testid={`device-proxy-control-${serial}`}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-2.5 py-2">
        <ShieldCheck className="w-4 h-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="shrink-0 text-[11px] font-medium text-muted-foreground">Proxy</span>
        <select
          aria-label={`Proxy for device ${serial}`}
          data-testid={`select-device-proxy-${serial}`}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-60"
          value={proxyId == null ? "" : String(proxyId)}
          disabled={loading || busy || Boolean(proxyConfigError)}
          onChange={event => { void handleSelection(event.target.value); }}
        >
          <option value="">Device default connection</option>
          {proxyId != null && !currentProxyExists && (
            <option value={String(proxyId)}>Missing Proxy Manager entry</option>
          )}
          {proxies.map(proxy => (
            <option key={proxy.id} value={String(proxy.id)}>
              {proxy.proxyType === "adapter"
                ? `Adapter: ${proxy.adapterName || proxy.name || "network"}`
                : `${proxy.name || `${proxy.host}:${proxy.port}`} (${proxy.proxyType === "socks5" ? "SOCKS5" : "HTTP"})`}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label={`Reapply proxy for device ${serial}`}
          data-testid={`button-reapply-device-proxy-${serial}`}
          title="Apply the selected route again"
          disabled={loading || busy || Boolean(proxyConfigError) || !online}
          onClick={() => { void applySavedAssignment(true, true); }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </button>
      </div>
      <div className={`mt-1 flex min-h-4 items-center gap-1 text-[10px] ${failed ? "text-destructive" : "text-muted-foreground"}`} data-testid={`status-device-proxy-${serial}`}>
        {proxyId == null && !failed ? <Wifi className="w-3 h-3 shrink-0" aria-hidden="true" /> : null}
        <span>{proxyConfigError || (loading ? "Loading saved proxies…" : (status || (proxyId == null ? "Using device default connection" : selectedLabel)))}</span>
      </div>
    </div>
  );
}

export function FarmDeviceProxySettings({
  serial,
  online,
}: {
  serial: string;
  online: boolean;
}) {
  const [proxies, setProxies] = useState<FarmProxyOption[]>([]);
  const [assignments, setAssignments] = useState<Record<string, number | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/mobile/device-proxies", { cache: "no-store" })
      .then(async response => {
        const data = await readJson(response);
        if (!response.ok) throw new Error(data?.error ?? "Could not load saved proxies");
        if (!data || !Array.isArray(data.proxies) || !data.assignments || typeof data.assignments !== "object") {
          throw new Error("The saved proxy settings response was incomplete");
        }
        if (cancelled) return;
        setProxies(data.proxies);
        setAssignments(data.assignments);
      })
      .catch(loadError => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Could not load saved proxy settings");
        }
        console.error("[PhoneFarm] device proxy settings failed to load", loadError);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [serial]);

  return (
    <section
      className="rounded-xl border border-border bg-card p-5"
      data-testid={`device-network-route-${serial}`}
    >
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-foreground">Device Network Route</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Applies to every account slot on this phone. Leave it on the default connection to use the phone’s normal network.
        </p>
      </div>
      <FarmDeviceProxyControl
        serial={serial}
        online={online}
        loading={loading}
        proxyId={loading || error ? undefined : (assignments[serial] ?? null)}
        proxies={proxies}
        proxyConfigError={error}
        onProxyIdChange={(deviceSerial, proxyId) => {
          setAssignments(previous => ({ ...previous, [deviceSerial]: proxyId }));
        }}
      />
    </section>
  );
}
