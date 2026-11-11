import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, Power, RefreshCw, ShieldCheck, Wifi } from "lucide-react";
import { useCreateProxy } from "@/hooks/use-proxies";

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
  const [manualInstallReady, setManualInstallReady] = useState(false);
  const [routeEnabled, setRouteEnabled] = useState(true);
  const handledAssignment = useRef<number | null | undefined>(undefined);
  const handledOnline = useRef(false);
  const selectedProxy = proxies.find(proxy => proxy.id === proxyId);
  const selectedLabel = selectedProxy
    ? selectedProxy.proxyType === "adapter"
      ? `Adapter: ${selectedProxy.adapterName || selectedProxy.name || "network"}`
      : `${selectedProxy.name || `${selectedProxy.host}:${selectedProxy.port}`} (${selectedProxy.proxyType === "socks5" ? "SOCKS5" : "HTTP"})`
    : "Laptop internet over USB";

  const applySavedAssignment = useCallback(async (showProgress: boolean, force = false) => {
    if (!online) {
      setStatus(proxyId == null ? "Laptop internet applies when connected" : "Saved; applies when connected");
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
          setRouteEnabled(current?.routeEnabled !== false);
          if (current?.routeEnabled === false) {
            setStatus("Route cancelled. The phone will use its normal connection.");
            setFailed(false);
            return;
          }
          if (current?.routeStatus?.error) {
            setStatus(current.routeStatus.error);
            setFailed(true);
            return;
          }
          const assignmentMatches = proxyId == null
            ? current?.proxyId == null
            : current?.proxyId === proxyId &&
              (selectedProxy?.proxyType === "adapter"
                ? current?.upstreamProxy === `adapter:${selectedProxy.adapterName ?? "unknown"}`
                : current?.upstreamProxy === `${selectedProxy?.host}:${selectedProxy?.port}`);
          const transportReady = current?.adbReverseActive === true;
          const matches = assignmentMatches && current?.relayActive === true && transportReady;
          if (matches) {
            setStatus(proxyId == null ? "Laptop internet tunnel is active" : `Applied: ${selectedLabel}`);
            setFailed(false);
            return;
          }
          if (assignmentMatches && current?.routeStatus?.starting === true && transportReady) {
            setStatus("Waiting for the one-time Android VPN approval. Tap Allow on the phone to activate the laptop route.");
            setFailed(false);
            return;
          }
          if (!force) {
            setStatus("Saved. Aura will apply this route automatically when the phone is ready.");
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
      setRouteEnabled(true);
      setStatus(result.message ?? (proxyId == null ? "Laptop internet tunnel is active" : "Proxy route applied"));
      setFailed(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not apply the device proxy");
      setFailed(true);
    } finally {
      if (showProgress) setBusy(false);
    }
  }, [online, proxyId, selectedLabel, selectedProxy, serial]);

  useEffect(() => {
    if (!online || !routeEnabled) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/proxy-status`);
        const current = await readJson(response);
        if (!response.ok) return;
        if (current?.routeEnabled === false) {
          setRouteEnabled(false);
          setStatus("Route cancelled. The phone will use its normal connection.");
          setFailed(false);
          return;
        }
        if (current?.routeStatus?.error) {
          if (!manualInstallReady) setStatus(current.routeStatus.error);
          setFailed(true);
        } else if (current?.relayActive && current?.adbReverseActive) {
          setStatus(proxyId == null ? "Laptop internet tunnel is active" : `Applied: ${selectedLabel}`);
          setFailed(false);
          setManualInstallReady(false);
        } else if (current?.routeStatus?.starting) {
          setStatus("Waiting for the one-time Android VPN approval. Tap Allow on the phone to activate the laptop route.");
          setFailed(false);
        }
      } catch {}
    }, 2500);
    return () => window.clearInterval(timer);
  }, [online, manualInstallReady, proxyId, routeEnabled, selectedLabel, serial]);

  useEffect(() => {
    if (loading || proxyId === undefined) return;
    if (!online) {
      handledOnline.current = false;
      void fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/proxy-status`)
        .then(async response => ({ response, current: await readJson(response) }))
        .then(({ response, current }) => {
          if (!response.ok) return;
          const enabled = current?.routeEnabled !== false;
          setRouteEnabled(enabled);
          if (!enabled) {
            setStatus("Route cancelled. The phone will use its normal connection.");
            setFailed(false);
          } else if (current?.routeStatus?.error) {
            setStatus(current.routeStatus.error);
            setFailed(true);
          } else {
            setStatus(proxyId == null ? "Laptop internet applies when connected" : "Saved; applies when connected");
            setFailed(false);
          }
        })
        .catch(() => {});
      setFailed(false);
      return;
    }
    if (handledAssignment.current === proxyId && handledOnline.current) return;
    handledAssignment.current = proxyId;
    handledOnline.current = true;
    void applySavedAssignment(false);
  }, [applySavedAssignment, loading, online, proxyId, serial]);

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
      setRouteEnabled(true);
      setStatus(result.warning ?? result.message ?? "Proxy assignment saved");
      setFailed(Boolean(result.warning));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save the device proxy");
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const cancelSavedRoute = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/stop-proxy`, {
        method: "POST",
      });
      const result = await readJson(response);
      if (!response.ok || result?.ok !== true) {
        throw new Error(result?.error ?? "Could not cancel the device route");
      }
      setRouteEnabled(false);
      setManualInstallReady(false);
      setStatus(result.message ?? "Route cancelled. The phone will use its normal connection.");
      setFailed(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not cancel the device route");
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const stageHelperForManualInstall = async () => {
    setBusy(true);
    setStatus("Copying the helper installer to the phone…");
    setFailed(false);
    try {
      const response = await fetch(
        `/api/mobile/devices/${encodeURIComponent(serial)}/stage-reverse-tether-apk`,
        { method: "POST" },
      );
      const result = await readJson(response);
      if (!response.ok || result?.ok !== true) {
        throw new Error(result?.error ?? "Could not copy the helper installer to the phone");
      }
      setManualInstallReady(true);
      setStatus(result.message ?? "Copied to Downloads. Open File Manager on the phone and install AuraGnirehtet.apk, then retry the route.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not copy the helper installer to the phone");
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const currentProxyExists = proxyId == null || proxies.some(proxy => proxy.id === proxyId);
  const canStageManualInstall =
    failed && /INSTALL_FAILED_USER_RESTRICTED|Install canceled by user/i.test(status);
  const canApplyRoute = failed || !routeEnabled;

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
            <option value="">Laptop internet over USB</option>
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
          aria-label={`${routeEnabled && !failed ? "Cancel" : failed ? "Retry" : "Apply"} route for device ${serial}`}
          data-testid={`button-reapply-device-proxy-${serial}`}
          title={routeEnabled && !failed ? "Cancel the saved route" : failed ? "Retry the selected route" : "Save and apply this route until cancelled"}
          disabled={busy || (canApplyRoute && (loading || Boolean(proxyConfigError) || !online))}
          onClick={() => {
            if (routeEnabled && !failed) void cancelSavedRoute();
            else void applySavedAssignment(true, true);
          }}
          className="flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted-foreground hover:bg-background hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : routeEnabled && !failed ? <Power className="w-3.5 h-3.5" /> : <RefreshCw className="w-3.5 h-3.5" />}
          <span>{busy ? "Working" : routeEnabled && !failed ? "Cancel" : failed ? "Retry" : "Apply"}</span>
        </button>
        {routeEnabled && failed && (
          <button
            type="button"
            aria-label={`Cancel route for device ${serial}`}
            onClick={() => { void cancelSavedRoute(); }}
            disabled={busy}
            className="h-7 shrink-0 rounded-md px-2 text-[11px] font-medium text-muted-foreground hover:bg-background hover:text-destructive disabled:opacity-40"
          >
            Cancel
          </button>
        )}
      </div>
      <div className={`mt-1 flex min-h-4 items-center gap-1 text-[10px] ${failed ? "text-destructive" : "text-muted-foreground"}`} data-testid={`status-device-proxy-${serial}`}>
        {proxyId == null && !failed ? <Wifi className="w-3 h-3 shrink-0" aria-hidden="true" /> : null}
        <span className="break-words">{proxyConfigError || (loading ? "Loading saved proxies…" : (status || (proxyId == null ? "Laptop internet over USB" : selectedLabel)))}</span>
      </div>
      {canStageManualInstall && !manualInstallReady && (
        <button
          type="button"
          onClick={() => { void stageHelperForManualInstall(); }}
          disabled={busy || loading || !online}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Copy helper to phone for manual install
        </button>
      )}
      <p className="mt-1 text-[10px] text-muted-foreground">
        Saved routes reapply after Aura or phone restarts until cancelled. Requires USB debugging and one VPN approval per phone. Phone Wi-Fi and mobile data are paused while this route is active, then restored when disconnected.
        {proxyId != null
          ? selectedProxy?.proxyType === "socks5"
            ? " The assigned SOCKS5 proxy carries TCP and UDP traffic."
            : " The assigned HTTP proxy carries TCP; DNS uses the laptop network and other UDP is blocked."
          : ""}
      </p>
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
  const [hostPort, setHostPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const createProxy = useCreateProxy();

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
          Applies to every account slot on this phone. The default route sends phone internet through the laptop over USB.
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
      <form
        className="mt-4 border-t border-border pt-4"
        data-testid={`form-add-device-proxy-${serial}`}
        onSubmit={async event => {
          event.preventDefault();
          setSaveError(null);
          const input = hostPort.trim().replace(/^https?:\/\//i, "");
          const separator = input.lastIndexOf(":");
          const host = input.slice(0, separator).replace(/^\[|\]$/g, "").trim();
          const port = Number(input.slice(separator + 1));
          if (separator < 1 || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
            setSaveError("Enter a valid proxy as host:port.");
            return;
          }

          setSaving(true);
          try {
            const created = await createProxy.mutateAsync({
              host,
              port,
              username: username.trim() || null,
              password: password || null,
            });
            const newOption: FarmProxyOption = {
              id: created.id,
              name: created.name,
              host: created.host,
              port: created.port,
              proxyType: (created as { proxyType?: string }).proxyType ?? "http",
            };
            setProxies(previous => [...previous, newOption]);

            const response = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/proxy`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ proxyId: created.id }),
            });
            const result = await readJson(response);
            if (!response.ok || result?.ok !== true) {
              throw new Error(result?.error ?? "Proxy was saved but could not be assigned to this device.");
            }

            setAssignments(previous => ({ ...previous, [serial]: created.id }));
            setHostPort("");
            setUsername("");
            setPassword("");
          } catch (saveFailure) {
            setSaveError(saveFailure instanceof Error ? saveFailure.message : "Could not save and assign this proxy.");
          } finally {
            setSaving(false);
          }
        }}
      >
        <p className="mb-2 text-xs font-medium text-foreground">Enter a new HTTP proxy</p>
        <p className="mb-3 text-[11px] text-muted-foreground">
          It will be saved in Proxy Manager and assigned to this phone.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="text-[11px] text-muted-foreground">
            Proxy:Port
            <input
              required
              type="text"
              value={hostPort}
              onChange={event => setHostPort(event.target.value)}
              placeholder="proxy.example.com:8080"
              aria-label="Proxy host and port"
              data-testid={`input-device-proxy-host-port-${serial}`}
              className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
            />
          </label>
          <label className="text-[11px] text-muted-foreground">
            Username
            <input
              type="text"
              value={username}
              onChange={event => setUsername(event.target.value)}
              autoComplete="off"
              aria-label="Proxy username"
              data-testid={`input-device-proxy-username-${serial}`}
              className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
            />
          </label>
          <label className="text-[11px] text-muted-foreground">
            Password
            <input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              autoComplete="new-password"
              aria-label="Proxy password"
              data-testid={`input-device-proxy-password-${serial}`}
              className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
            />
          </label>
        </div>
        {saveError && (
          <p className="mt-2 text-xs text-destructive" role="alert" data-testid={`error-device-proxy-save-${serial}`}>
            {saveError}
          </p>
        )}
        <button
          type="submit"
          disabled={saving || loading || Boolean(error)}
          data-testid={`button-save-device-proxy-${serial}`}
          className="mt-3 inline-flex h-8 items-center justify-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save and assign to this phone
        </button>
      </form>
    </section>
  );
}
