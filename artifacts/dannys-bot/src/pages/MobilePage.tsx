le:/i.test(line);
             // findReelActionIcons emits its diagnostic column dump through
             // several individually timestamped lines. Those lines are not
             // always full XML attributes, so keep them together explicitly
             // instead of relying only on isAccessibilityDumpLine().
             const isReelIconScanLine = (line: string) =>
               /\[reel-icons\]/i.test(line) ||
               /\b(?:x|y)=\d+\b.*\b(?:cd|rid|cls|txt)=/i.test(line) ||
               /scanning right-side action column/i.test(line);
             const isReelsBurstLine = (line: string) =>
               /\b(?:Reel|View Reels):\s+/i.test(line) ||
               /▶\s*View Reels\b/i.test(line);
             // Swipe-screen summaries are intentionally verbose diagnostics
             // (bytes, markers, labels, and completed coordinates). Keep the
             // whole diagnostic block behind a chevron even when it contains
             // fewer than three rendered rows.
             const isSwipeScreenDiagnostic = (line: string) =>
               /\bswipe screen (?:BEFORE|AFTER)\s+—/i.test(line);
             const isSwipeScreenBlockLine = (line: string) =>
               isSwipeScreenDiagnostic(line) ||
               /\badvance swipe\b/i.test(line);
             const groups: string[][] = [];
             for (const line of lines) {
               const previous = groups[groups.length - 1];
                const previousIsDump = previous?.some(isAccessibilityDumpLine) ?? false;
                const previousIsInjectBurst = previous?.some(isInjectBrowsingBurstLine) ?? false;
                const previousIsStoryTray = previous?.some(isStoryTrayBurstLine) ?? false;
                 const previousIsStoryTrayDiagnostic = previous?.some(isStoryTrayDiagnosticLine) ?? false;
                const previousIsReelIconScan = previous?.some(isReelIconScanLine) ?? false;
                const previousIsReelsBurst = previous?.some(isReelsBurstLine) ?? false;
                const previousIsSwipeScreen = previous?.some(isSwipeScreenDiagnostic) ?? false;
                const previousIsSwipeScreenBlock = previous?.some(isSwipeScreenBlockLine) ?? false;
                if (
                  previous &&
                  previous.length > 0 &&
                  (
                    timestampOf(previous[0]) === timestampOf(line) ||
                    (previousIsDump && isAccessibilityDumpLine(line)) ||
                    (previousIsInjectBurst && isInjectBrowsingBurstLine(line)) ||
                    (previousIsStoryTray && isStoryTrayBurstLine(line)) ||
                    (previousIsStoryTrayDiagnostic && (
                      isStoryTrayDiagnosticLine(line) || isAccessibilityDumpLine(line)
                    )) ||
                    (previousIsReelIconScan && (
                      isReelIconScanLine(line) || isAccessibilityDumpLine(line)
                    )) ||
                    (previousIsReelsBurst && (
                      isReelsBurstLine(line) ||
                      isReelIconScanLine(line) ||
                      isAccessibilityDumpLine(line)
                    )) ||
                    (previousIsSwipeScreen && (
                      isSwipeScreenBlockLine(line) ||
                      isReelIconScanLine(line) ||
                      isAccessibilityDumpLine(line)
                    )) ||
                    (previousIsSwipeScreenBlock && (
                      isSwipeScreenBlockLine(line) ||
                      isReelIconScanLine(line) ||
                      isAccessibilityDumpLine(line)
                    ))
                  )
                ) previous.push(line);
               else groups.push([line]);
             }
              const renderLine = (l: string, i: number, key: string, groupControl?: React.ReactNode) => {
              // Parse:  [HH:MM:SS AM/PM]  [Xm Ys / Xs]  message
              //         [HH:MM:SS AM/PM]               message   (no duration)
              const m   = l.match(/^\[([^\]]+)\]\s*(?:\[(\d+m \d+(?:\.\d+)?s|\d+(?:\.\d+)?s)\]\s*)?([\s\S]*)$/);
              const ts  = m?.[1] ?? '';
              const dur = m?.[2] ?? '';
              const msg = m ? (m[3] ?? '') : l;
                // Account switching is always gold. The destination handle is
                // highlighted pink, but that emphasis must not recolour the
                // surrounding switch diagnostics.
                const isAccountSwitchMessage = isAccountSwitchLogMessage(msg);
               const accountSwitchTarget = isAccountSwitchMessage
                 ? msg.match(/(^|[\s(":=])(@[A-Za-z0-9._]{2,40})(?=$|[\s"…—,.;:)])/i)
                 : null;
               const accountTargetStart = accountSwitchTarget
                 ? (accountSwitchTarget.index ?? 0) + accountSwitchTarget[1].length
                 : -1;
               const accountTargetEnd = accountTargetStart >= 0
                 ? accountTargetStart + (accountSwitchTarget?.[2].length ?? 0)
                 : -1;

              // Track the active tool from its header. Once active, that tool
              // owns every following line until the next tool header or cycle
              // boundary. This is deliberately context-first: a Reel opened
              // from Explore is still an Explore log line and stays green.
               const detectedHeader = detectDebugToolHeader(msg);
               // A real tool header is a hard context boundary. In
               // particular, "Starting View Explore Page" must reset the
               // previous gold account-switch block to Explore green.
               if (detectedHeader) currentTool = detectedHeader;
               else if (isAccountSwitchMessage) currentTool = "accountSwitch";
              const isCycleBoundary = /Cycle\s+(complete|failed|aborted)/i.test(msg);
              const messageColor = isCycleBoundary
                  ? "#ffffff"
                   : currentTool
                     ? DEBUG_TOOL_COLORS[currentTool]
                    : "#ffffff";
              if (isCycleBoundary) currentTool = null;

                return (
                  <div key={key} className="flex min-w-0 py-[1px]">
                  <span className="text-white whitespace-nowrap shrink-0 select-none w-[5rem]">[{ts}]</span>
                   <span className="w-4 shrink-0 inline-flex items-center justify-center">
                     {groupControl}
                   </span>
                   <span className="shrink-0 whitespace-nowrap text-white w-[5rem]">{dur ? `[${dur}]` : ''}</span>
                   <span className="flex-1 min-w-0 break-words" style={{ color: messageColor }}>
                    {accountSwitchTarget ? (
                      <>
                        {msg.slice(0, accountTargetStart)}
                         <span className="font-semibold" style={{ color: "#f472b6" }}>{msg.slice(accountTargetStart, accountTargetEnd)}</span>
                        {msg.slice(accountTargetEnd)}
                      </>
                    ) : msg}
                  </span>
                </div>
              );
             };
              const renderedGroups = groups.map((group, groupIndex) => {
                // Keep ordinary same-timestamp groups compact, but show only
                // the summary/header for Reels bursts. Reels often immediately
                // emit a very large accessibility/XML dump; showing three
                // rows still exposed that clutter before the chevron.
                const isReelsGroup = group.some(isReelsBurstLine) ||
                  group.some(isReelIconScanLine);
                const isStoryTrayDiagnosticGroup = group.some(isStoryTrayDiagnosticLine);
                const isSwipeScreenGroup = group.some(isSwipeScreenDiagnostic);
                const visibleRowCount = isReelsGroup || isStoryTrayDiagnosticGroup || isSwipeScreenGroup ? 1 : 3;
                // Swipe-screen diagnostics are collapsed even when the
                // diagnostic consists of only one rendered row. These lines
                // are inherently verbose and must never occupy the log as
                // expanded diagnostic noise.
                const collapsible = isStoryTrayDiagnosticGroup || isSwipeScreenGroup || group.length > visibleRowCount;
               const groupKey = `${groupIndex}:${timestampOf(group[0])}`;
               const expanded = expandedLogGroups.has(groupKey);
               if (!collapsible || expanded) {
                 return (
                   <React.Fragment key={groupKey}>
                      {group.map((line, index) => renderLine(
                        line,
                        index,
                        `${groupKey}:${index}`,
                         index === visibleRowCount - 1 && collapsible ? (
                          <button
                            type="button"
                            aria-label={`Collapse ${group.length} log rows at ${timestampOf(group[0])}`}
                            title="Collapse same-timestamp log rows"
                            onClick={() => setExpandedLogGroups(prev => {
                              const next = new Set(prev);
                              next.delete(groupKey);
                              return next;
                            })}
                            className="inline-flex text-white/60 hover:text-white"
                          >
                            <ChevronDown className="h-3 w-3" />
                          </button>
                        ) : undefined
                      ))}
                   </React.Fragment>
                 );
               }
                const collapsedContent = group.join("\n");
                return (
                  <React.Fragment key={groupKey}>
                    {/* Keep the complete group available to accessibility tools
                        and DOM-based readers while only the first rows are
                        painted. Copy/Export already use the source `lines`
                        array, so collapsing is presentation-only. */}
                    <pre
                      className="sr-only"
                      aria-label={`Collapsed log group containing ${group.length} rows`}
                      data-log-group-content={collapsedContent}
                    >
                      {collapsedContent}
                    </pre>
                    {group.slice(0, visibleRowCount).map((line, index) => renderLine(
                      line,
                      index,
                      `${groupKey}:visible:${index}`,
                      index === visibleRowCount - 1 ? (
                        <button
                          type="button"
                          aria-label={`Expand ${group.length} log rows at ${timestampOf(group[0])}`}
                            title={`Expand ${group.length} log rows — full content remains available to Copy and Export`}
                          onClick={() => setExpandedLogGroups(prev => new Set(prev).add(groupKey))}
                          className="inline-flex text-white/60 hover:text-white"
                        >
                          <ChevronRight className="h-3 w-3" />
                        </button>
                      ) : undefined
                    ))}
                  </React.Fragment>
                );
              });
              debugLogContextRef.current = currentTool;
              return renderedGroups;
          })()
        }
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const TOTAL_SLOTS = 1;

type MobileTab = "account" | "browser" | "metrics" | "phonesettings" | "actionlog" | "log";
// Left-side tabs shown in order before the spacer.
const MOBILE_TABS_LEFT: { id: MobileTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "account",      label: "Accounts",  icon: Users       },
  { id: "phonesettings",label: "My Device", icon: MonitorSmartphone },
  { id: "metrics",      label: "Metrics",   icon: BarChart2   },
  // Browser remains implemented and wired below, but is intentionally hidden
  // from the Device tab navigation until it is needed again.
];
// Right-side tabs — pushed to the far right with ml-auto on the first one.
const MOBILE_TABS_RIGHT: { id: MobileTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "actionlog", label: "Action Log",    icon: ClipboardList },
  { id: "log",       label: "Debugging Log", icon: Bug           },
];

/** Deterministic numeric browser-profile ID from a device serial.
 *  Kept in the 1,000,000–9,999,999 range to avoid collision with real DB profile IDs. */
function serialToBrowserId(serial: string): number {
  let h = 5381;
  for (let i = 0; i < serial.length; i++) {
    h = (((h << 5) + h) ^ serial.charCodeAt(i)) >>> 0;
  }
  return 1_000_000 + (h % 8_999_999);
}

// Regex for detecting bot automation taps in log lines.
// Matches "tapping … at (X,Y)" / "tapped … (X,Y)" patterns emitted by the
// automation engine.  Plain manual "Tap → (X,Y)" lines are deliberately
// excluded so user taps aren't double-counted as bot markers.
const BOT_TAP_RE = /tapp(?:ing|ed)[^\n(]*\((\d+),\s*(\d+)\)/i;

// Regex for filtering action-only lines into the Action Log tab.
// Matches automation action keywords emitted by the engine.
// Only cycle-level outcome lines go to the Action Log — no debug noise.
const ACTION_LOG_RE = /Cycle\s+(complete|failed|aborted)/i;

export function MobilePage() {
  // When navigated from the Phone Farm grid (/mobile/farm/:serial), only this
  // phone's serial is shown. When navigated directly (/mobile/farm with no
  // param) all connected phones are shown as before.
  const params = useParams<{ serial?: string }>();
  const targetSerial = params.serial ? decodeURIComponent(params.serial) : null;
  const devicePageStartedAtRef = useRef(performance.now());
  const previousTargetSerialRef = useRef<string | null>(targetSerial);
  useEffect(() => {
    const started = Number(sessionStorage.getItem("mobile_device_nav_started_at"));
    const navigationMs = Number.isFinite(started) && started > 0
      ? performance.now() - started
      : null;
    writeUiSpeedLog("mobile-page-target-changed", {
      from: previousTargetSerialRef.current,
      to: targetSerial,
      navigationMs,
      pageElapsedMs: performance.now() - devicePageStartedAtRef.current,
    });
    previousTargetSerialRef.current = targetSerial;
    if (navigationMs !== null) sessionStorage.removeItem("mobile_device_nav_started_at");
  }, [targetSerial]);
  const search = useSearch();
  const initialSlot = (() => {
    const s = new URLSearchParams(search).get("slot");
    return s !== null ? Number(s) : null;
  })();
  const autoPowerOn = new URLSearchParams(search).get("autopower") === "1"
    || (targetSerial !== null && sessionStorage.getItem("mobile_autopower_serial") === targetSerial);

  const [data,    setData]    = useState<PhonesResponse | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [phoneDims, setPhoneDims] = useState<{ w: number; h: number } | null>(null);
  const handlePhoneDimensions = useCallback((w: number, h: number) => {
    setPhoneDims(previous => (
      previous && previous.w === w && previous.h === h
        ? previous
        : { w, h }
    ));
  }, []);
  // Measured size of the pane the phone shell lives in — feeds PhoneSlot's
  // exact-fit sizing (see PhoneSlot's "Exact shell sizing" block). Must be
  // the real available box, not derived from CSS aspect-ratio math, or the
  // header/nav chrome eats into the phone-ratio budget again.
  // A plain useRef + `useEffect(..., [])` here would silently never attach:
  // this pane <div> is behind a loading/data gate, so on first mount (while
  // still loading) the ref is null, the effect bails out, and nothing ever
  // re-runs it once the div actually appears — paneSize stays null forever
  // and PhoneSlot's exact-fit sizing permanently falls back to "fill the
  // box", which is the pillarbox regression. A ref *callback* (via state)
  // re-fires whenever the element itself changes, including "was null, now
  // mounted", so it reliably attaches once the div exists.
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null);
  const [paneSize, setPaneSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!paneEl) return;
    const measure = () => {
      const r = paneEl.getBoundingClientRect();
      setPaneSize(previous => (
        previous && previous.w === r.width && previous.h === r.height
          ? previous
          : { w: r.width, h: r.height }
      ));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(paneEl);
    return () => ro.disconnect();
  }, [paneEl]);
  const [activeTab, setActiveTab] = useState<MobileTab>("account");

  // Metrics and Action Log are overview-level tabs. Once the user opens a
  // specific device from the Phone Farm grid, the screen is dedicated to that
  // device and those two tabs are not useful visually. Keep the tab state
  // intact for the farm overview, but never leave the detail view showing a
  // panel whose tab has been hidden.
  const deviceDetailView = !!targetSerial;
  useEffect(() => {
    if (deviceDetailView && (activeTab === "metrics" || activeTab === "actionlog")) {
      setActiveTab("account");
    }
  }, [deviceDetailView, activeTab]);

  // Derived phone/slot data — declared here so activeSerial is in scope for
  // all hooks below (useEffect dependency arrays are evaluated synchronously).
  const allPhones = data?.phones ?? [];
  const phones = targetSerial
    ? allPhones.filter(p => p.serial === targetSerial)
    : [...allPhones].sort((a, b) => a.serial.localeCompare(b.serial));
  const slots: (UsbPhone | null)[] = Array.from({ length: TOTAL_SLOTS }, (_, i) => phones[i] ?? null);
  const activeSerial = slots[0]?.serial ?? null;
  const { navigateTo } = useBrowserWindows();
  const openBrowserProfile = useCallback((username: string) => {
    const cleanUsername = username.trim().replace(/^@+/, "");
    if (!cleanUsername || !activeSerial) return;
    setActiveTab("browser");
    navigateTo(
      serialToBrowserId(activeSerial),
      activeSerial,
      "",
      `https://www.instagram.com/${encodeURIComponent(cleanUsername)}/`,
    );
  }, [activeSerial, navigateTo]);

  // ── Device Browser proxy config ───────────────────────────────────────────
  const [browserProxyHostPort, setBrowserProxyHostPort] = useState("");
  const [browserProxyUser,     setBrowserProxyUser]     = useState("");
  const [browserProxyPass,     setBrowserProxyPass]     = useState("");
  const [browserProxySaving,   setBrowserProxySaving]   = useState(false);
  const [browserProxyError,    setBrowserProxyError]    = useState<string | null>(null);
  const [browserUseLocalIp,    setBrowserUseLocalIp]    = useState(false);

  useEffect(() => {
    if (!activeSerial) return;
    fetch(`/api/mobile/devices/${encodeURIComponent(activeSerial)}/browser-proxy`)
      .then(r => r.json())
      .then(d => {
        if (d.proxy?.useLocalIp) {
          setBrowserUseLocalIp(true);
          setBrowserProxyHostPort("");
          setBrowserProxyUser("");
          setBrowserProxyPass("");
        } else if (d.proxy) {
          setBrowserUseLocalIp(false);
          setBrowserProxyHostPort(`${d.proxy.host}:${d.proxy.port}`);
          setBrowserProxyUser(d.proxy.username ?? "");
          setBrowserProxyPass(d.proxy.password ?? "");
        } else {
          setBrowserUseLocalIp(false);
          setBrowserProxyHostPort("");
          setBrowserProxyUser("");
          setBrowserProxyPass("");
        }
      })
      .catch(() => {});
  }, [activeSerial]);

  const saveBrowserProxy = async () => {
    if (!activeSerial) return;
    setBrowserProxySaving(true);
    setBrowserProxyError(null);
    try {
      let payload: object;
      if (browserUseLocalIp) {
        payload = { useLocalIp: true };
      } else {
        const [host, portStr] = browserProxyHostPort.trim().split(":");
        const port = parseInt(portStr ?? "", 10);
        if (!host || !portStr || isNaN(port) || port < 1 || port > 65535) {
          setBrowserProxyError("Enter proxy as host:port (e.g. 192.168.1.254:29842)");
          return;
        }
        payload = { host, port, username: browserProxyUser, password: browserProxyPass };
      }
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(activeSerial)}/browser-proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body?.ok) setBrowserProxyError(body?.error ?? "Save failed");
    } catch (e: any) {
      setBrowserProxyError(e?.message ?? "Network error");
    } finally {
      setBrowserProxySaving(false);
    }
  };

  // Remembers where the user was before opening the Debugging Log tab so the
  // ← back button can return them to the exact same location (tab + slot).
  const [prevLogLocation, setPrevLogLocation] = useState<{ tab: MobileTab; slotIdx: number | null } | null>(null);
  const accountPanelRef = useRef<AccountSettingsPanelHandle>(null);
  // Per-serial "user explicitly turned the live view on" flag. Visiting the
  // Mobile tab, or a phone simply being connected, must never by itself
  // start streaming/waking the device — only pressing Power (below) or the
  // automation toggle being enabled does.
  const [liveOn, setLiveOn] = useState<Record<string, boolean>>(() => (
    targetSerial && autoPowerOn ? { [targetSerial]: true } : {}
  ));
  useEffect(() => {
    if (!targetSerial) return;
    if (!autoPowerOn) return;
    setLiveOn(previous => (
      previous[targetSerial]
        ? previous
        : { ...previous, [targetSerial]: true }
    ));
    if (sessionStorage.getItem("mobile_autopower_serial") === targetSerial) {
      sessionStorage.removeItem("mobile_autopower_serial");
    }
  }, [targetSerial, autoPowerOn]);

  // ── Slot customizations (wallpaper + text layers) — persisted to localStorage
  const [slotCustom, setSlotCustom] = useState<Record<number, SlotCustomization>>(() => {
    try {
      const stored = localStorage.getItem('slot-customizations');
      return stored ? JSON.parse(stored) : {};
    } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem('slot-customizations', JSON.stringify(slotCustom)); }
    catch { /* quota exceeded — ignore */ }
  }, [slotCustom]);

  // ── Inspect state ───────────────────────────────────────────────────────────
  // Lifted here so the LogPanel button (sibling of PhoneSlot) can toggle it.
  const [inspectMode, setInspectMode] = useState(false);

  // ── Log Record state ────────────────────────────────────────────────────────
  const [logRecMode,    setLogRecMode]    = useState(false);
  const [logMarkers,    setLogMarkers]    = useState<LogMarker[]>([]);
  // Ref so addLog's stable useCallback closure can read current logRecMode
  // without going stale.
  const logRecModeRef = useRef(false);
  useEffect(() => { logRecModeRef.current = logRecMode; }, [logRecMode]);

  const addLogMarker = useCallback((m: LogMarker) => {
    setLogMarkers(prev => [...prev, m]);
  }, []);

  const refresh = useCallback(async (showSpinner = false) => {
    const pollStarted = performance.now();
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const next = await fetchPhones();
      let changed = false;
      setData(previous => {
        changed = !previous || !samePhoneSnapshot(previous, next);
        return previous && !changed ? previous : next;
      });
      writeUiSpeedLog("usb-poll-complete", {
        durationMs: Math.round((performance.now() - pollStarted) * 10) / 10,
        showSpinner,
        phoneCount: next.phones.length,
        targetSerial,
        snapshotChanged: changed,
      });
    }
    catch (e: any) {
      writeUiSpeedLog("usb-poll-failed", {
        durationMs: Math.round((performance.now() - pollStarted) * 10) / 10,
        showSpinner,
        targetSerial,
        error: e?.message ?? String(e),
      });
      setError(e?.message ?? "Failed to check devices");
    }
    finally {
      setLoading(false);
    }
  }, [targetSerial]);

  useEffect(() => {
    refresh(true);
    const id = setInterval(() => refresh(false), 3_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Points at whichever rendered PhoneSlot corresponds to activeSerial, so
  // the Log tab (a sibling, not a child, of the mirror) can pull the live
  // decoded video frame size for Check Screen Info.
  const activeSlotRef = useRef<PhoneSlotHandle>(null);

  // Sticky phone: never pass null to AccountSettingsPanel due to transient USB
  // poll flickers. When phones[] empties briefly, keep the last seen phone so
  // phone?.serial stays stable → connectedKey doesn't increment → hydration
  // doesn't re-fire → run-loop timers stay alive.
  const stickySlot0Ref = useRef<UsbPhone | null>(null);
  if (slots[0] !== null) stickySlot0Ref.current = slots[0];

  // ── Global log state (persists regardless of which page is open) ────────────
  const {
    logLines,
    actionLogLines,
    addLog: _ctxAddLog,
    clearLogLines,
    clearActionLogLines,
  } = useDeviceLog(activeSerial);

  // Wrap the context addLog to preserve BOT_TAP_RE log-marker logic.
  const addLog = useCallback((msg: string) => {
    _ctxAddLog(msg);
    if (logRecModeRef.current) {
      const m = BOT_TAP_RE.exec(msg);
      if (m) {
        setLogMarkers(prev => [...prev, {
          x: parseInt(m[1], 10),
          y: parseInt(m[2], 10),
          t: Date.now(),
          type: "bot",
          label: msg.length > 80 ? msg.substring(0, 77) + "…" : msg,
        }]);
      }
    }
  }, [_ctxAddLog]);

  // True only while a slot's HST cycle is actively executing — bubbled up from
  // AccountSettingsPanel via onAnyEnabled (which checks s.running only).
  // Drops to false the moment all cycles stop → wallpaper/text returns.
  // This is one of exactly two conditions that turn the mirror on; the other
  // is the manual Power button (liveOn). Nothing else may activate the mirror.
  const [hstEnabled, setHstEnabled] = useState(false);
  // True while a Phone Apps cycle is actively executing — bubbled up from
  // AccountSettingsPanel via onPhoneAppsRunning. Activates the mirror alongside
  // hstEnabled and liveOn.
  const [phoneAppsRunning, setPhoneAppsRunning] = useState(false);
  const [restartRequested, setRestartRequested] = useState(() =>
    targetSerial !== null && sessionStorage.getItem("mobile-device-restart-requested") === targetSerial
  );
  useEffect(() => {
    const onRestart = (event: Event) => {
      const serial = (event as CustomEvent<{ serial?: string }>).detail?.serial;
      if (!serial || serial === targetSerial) setRestartRequested(true);
    };
    window.addEventListener("mobile-device-graceful-restart", onRestart);
    return () => window.removeEventListener("mobile-device-graceful-restart", onRestart);
  }, [targetSerial]);

  // Drop any previously-learned aspect ratio when the connected device
  // changes (or disconnects) — otherwise a stale ratio from the last phone
  // can briefly letterbox the next one before its first frame arrives.
  useEffect(() => { setPhoneDims(null); }, [activeSerial]);

  // Tracks which account slot is open in the Human Session Tool, so the header title updates.
  const [openAccountSlot, setOpenAccountSlot] = useState<number | null>(null);

  // Fetch the farm slot index for the targeted serial so the header can
  // show "Phone Farm - Slot X - Device Name" instead of just "Phone Farm".
  const [farmSlotIndex, setFarmSlotIndex] = useState<number | null>(null);
  useEffect(() => {
    if (!targetSerial) { setFarmSlotIndex(null); return; }
    fetch("/api/mobile/farm-devices")
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((d: { devices: Array<{ serial: string; slotIndex: number }> }) => {
        const dev = d.devices.find(dev => dev.serial === targetSerial);
        setFarmSlotIndex(dev?.slotIndex ?? null);
      })
      .catch(() => setFarmSlotIndex(null));
  }, [targetSerial]);

  // Keep an intentional manual mirror session alive through transient USB
  // polling gaps. A phone card can briefly disappear while ADB refreshes;
  // clearing liveOn here made Power On wake the phone and then tear down the
  // mirror a few seconds later. Deliberate Power Off still clears it.
  useEffect(() => {
    const connected = new Set(phones.map(p => p.serial));
    if (targetSerial && connected.has(targetSerial) && restartRequested) {
      setRestartRequested(false);
      if (sessionStorage.getItem("mobile-device-restart-requested") === targetSerial) {
        sessionStorage.removeItem("mobile-device-restart-requested");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phones.map(p => p.serial).join(","), targetSerial, restartRequested]);

  // Only true once we have real data AND either a phone is connected or one
  // of the setup panels needs to take over the whole content area.
  const showSplitView = !!(data && data.adbFound && !error && (phones.length > 0 || loading));

  // Resolved display info for the header when viewing a specific device.
  const targetPhone = targetSerial ? allPhones.find(p => p.serial === targetSerial) : null;
  const deviceFriendlyName = targetPhone
    ? ([targetPhone.manufacturer, targetPhone.marketName || targetPhone.model].filter(Boolean).join(" ") || targetSerial)
    : targetSerial;
  // Best-effort slot number: use farmSlotIndex once loaded, otherwise fall back
  // to the phone's index in the connected-phone list.
  const slotNum = farmSlotIndex ?? (targetSerial ? allPhones.findIndex(p => p.serial === targetSerial) + 1 || null : null);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      {/* h-screen + flex-col + overflow-hidden here (instead of the old
          overflow-y-auto page scroll) is required: it's what gives every
          descendant below a real, computed pixel height to stretch/percent
          against. Without it, "h-full" a few levels down silently resolves
          to 0 against an auto-height ancestor — which is why the phone used
          to render far down the page (extra collapsed space above it) and
          why taps landed on a zero-size element and did nothing. */}
      <main className="ml-[133px] flex-1 h-screen flex flex-col overflow-hidden">
        <LiveActivityTicker />
        {/* Header */}
        <div className="shrink-0 z-10 bg-background/95 backdrop-blur border-b border-border px-6 py-3 relative flex items-center justify-end">
          {/* Title — absolutely centred in the bar, independent of button widths */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="flex items-center gap-3 pointer-events-auto">
              <FilledFarmIcon className="w-5 h-5" style={{ color: "#1AD2F2" }} />
              <h1 className="text-lg font-bold text-foreground">
                {targetSerial
                  ? openAccountSlot !== null
                    ? `Phone Farm - Slot ${openAccountSlot + 1} - ${deviceFriendlyName ?? targetSerial}`
                    : `Phone Farm - ${deviceFriendlyName ?? targetSerial}`
                  : "Phone Farm"}
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => refresh(true)} disabled={loading}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors disabled:opacity-50">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />Refresh
            </button>
          </div>
        </div>

        {/* Setup / error states — the only part of the page allowed to scroll */}
        {!showSplitView && (
          <div className="flex-1 min-h-0 overflow-y-auto p-6">
            {error && (
              <div className="max-w-lg mx-auto mt-12 flex items-start gap-3 bg-destructive/10 border border-destructive/20 rounded-xl p-4">
                <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                <div>
                  <div className="text-sm font-semibold text-destructive">Could not reach server</div>
                  <div className="text-xs text-destructive/80 mt-0.5">{error}</div>
                </div>
              </div>
            )}

            {data && !data.adbFound && !error && <NoAdbPanel onSaved={() => refresh(true)} />}

            {data && data.adbFound && phones.length === 0 && !loading && !error && (
              <NoPhonesPanel rawOutput={data.rawOutput} restarting={restartRequested} />
            )}
          </div>
        )}

        {/* Phone (left half, full height) + automation settings (right half) */}
        {/* ALWAYS MOUNTED — never use {showSplitView && ...} here.  The outer
            conditional would unmount AccountSettingsPanel (and every
            SlotHumanSessionView inside it) whenever the USB poll transiently
            returns 0 phones for the targeted serial.  That destroyed all
            automation run-loop timers on every 3-second USB poll flicker.
            Use CSS hiding instead so the hooks stay alive through any gap. */}
        <div className={showSplitView ? "flex-1 min-h-0 flex" : "hidden"}>
            <div ref={setPaneEl} className="w-1/2 h-full flex items-center justify-center p-4 min-h-0">
              {/* Hidden on the Browser tab — panel keeps its width so the
                  right-hand tab bar never shifts position. */}
              {activeTab !== "browser" && slots.map((phone, i) => (
                <PhoneSlot
                  key={i}
                  phone={phone}
                  idx={i}
                  onLog={addLog}
                  onDimensions={handlePhoneDimensions}
                  phoneDims={phoneDims}
                  paneSize={paneSize}
                  // Mirror activates under exactly three conditions — nothing else:
                  //   • user clicked the Power button (liveOn) — manual override
                  //   • a HST cycle is actively executing right now (hstEnabled)
                  //   • a Phone Apps cycle is actively executing (phoneAppsRunning)
                  live={!!(phone && (liveOn[phone.serial] || hstEnabled || phoneAppsRunning))}
                  manualLive={!!(phone && liveOn[phone.serial])}
                  automationActive={hstEnabled || phoneAppsRunning}
                  onPower={() => { if (phone) setLiveOn(s => ({ ...s, [phone.serial]: !s[phone.serial] })); }}
                  ref={phone?.serial === activeSerial ? activeSlotRef : undefined}
                  inspectMode={inspectMode}
                  logRecMode={logRecMode}
                  logMarkers={logMarkers}
                  onExpectedTap={(x, y, kind) => addLogMarker({ x, y, t: Date.now(), type: kind ?? "expected" })}
                  custom={slotCustom[i] ?? DEFAULT_SLOT_CUSTOM}
                  onCustomChange={c => setSlotCustom(prev => ({ ...prev, [i]: c }))}
                />
              ))}
            </div>
            <div className="w-1/2 border-l border-border h-full min-h-0 flex flex-col">
              <div className="shrink-0 flex items-center border-b border-border px-4">
                {MOBILE_TABS_LEFT.map(t => (
                  (!deviceDetailView || t.id !== "metrics") && (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(t.id);
                      if (t.id === "account") accountPanelRef.current?.backToSlots();
                    }}
                    className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
                      activeTab === t.id
                        ? "border-primary text-foreground"
                        : "border-transparent text-foreground hover:text-foreground"
                    }`}
                  >
                    {t.label}<t.icon className="w-3.5 h-3.5 opacity-70" />
                  </button>
                  )
                ))}
                <div className="flex-1" />
                <DeviceQuickControls serial={activeSerial} />
                {MOBILE_TABS_RIGHT.map(t => (
                  (!deviceDetailView || t.id !== "actionlog") && (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      if (t.id === "log") {
                        setPrevLogLocation({ tab: activeTab, slotIdx: openAccountSlot });
                      }
                      setActiveTab(t.id);
                    }}
                    className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
                      activeTab === t.id
                        ? "border-primary text-foreground"
                        : "border-transparent text-foreground hover:text-foreground"
                    }`}
                  >
                    {t.label}<t.icon className="w-3.5 h-3.5 opacity-70" />
                  </button>
                  )
                ))}
              </div>
              <div className="flex-1 min-h-0 relative">
                {/* Accounts panel: always mounted so each slot's automation
                    hook persists across tab switches and navigation. */}
                <div className={activeTab === "account" ? "h-full" : "hidden"}>
                  <AccountSettingsPanel key={stickySlot0Ref.current?.serial ?? "no-device"} ref={accountPanelRef} phone={stickySlot0Ref.current} addLog={addLog} onSlotChange={setOpenAccountSlot} initialSlot={initialSlot} onAnyEnabled={setHstEnabled} onPhoneAppsRunning={setPhoneAppsRunning} onOpenBrowserProfile={openBrowserProfile} />
                </div>
                {/* Browser tab — isolated ghost browser per device serial */}
                {/* Positioned absolutely so it spans the full split-view width
                    (left: -100% reaches the left edge of the split container)
                    while the tab bar above stays exactly where it is. */}
                <div
                  className={activeTab === "browser"
                    ? "absolute top-0 right-0 bottom-0 bg-background flex flex-col z-10"
                    : "hidden"}
                  style={{ left: "-100%" }}
                >
                    {/* Proxy config bar */}
                    <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
                      <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">Proxy</span>
                      <input
                        type="text"
                        placeholder="host:port"
                        value={browserProxyHostPort}
                        onChange={e => setBrowserProxyHostPort(e.target.value)}
                        disabled={browserUseLocalIp}
                        className="h-7 rounded border border-border bg-background px-2 text-xs w-40 font-mono disabled:opacity-40 disabled:cursor-not-allowed"
                      />
                      <input
                        type="text"
                        placeholder="Username"
                        value={browserProxyUser}
                        onChange={e => setBrowserProxyUser(e.target.value)}
                        disabled={browserUseLocalIp}
                        className="h-7 rounded border border-border bg-background px-2 text-xs w-28 disabled:opacity-40 disabled:cursor-not-allowed"
                      />
                      <input
                        type="password"
                        placeholder="Password"
                        value={browserProxyPass}
                        onChange={e => setBrowserProxyPass(e.target.value)}
                        disabled={browserUseLocalIp}
                        className="h-7 rounded border border-border bg-background px-2 text-xs w-28 disabled:opacity-40 disabled:cursor-not-allowed"
                      />
                      <button
                        type="button"
                        disabled={browserProxySaving || (!browserUseLocalIp && !browserProxyHostPort.trim())}
                        onClick={saveBrowserProxy}
                        className="h-7 px-3 rounded text-xs font-medium bg-primary text-primary-foreground disabled:opacity-50"
                      >
                        {browserProxySaving ? "Saving…" : "Save"}
                      </button>
                      <label className="flex items-center gap-1.5 cursor-pointer select-none ml-1">
                        <input
                          type="checkbox"
                          checked={browserUseLocalIp}
                          onChange={e => setBrowserUseLocalIp(e.target.checked)}
                          className="w-3.5 h-3.5 accent-primary"
                        />
                        <span className="text-xs text-muted-foreground whitespace-nowrap">Use local PC's IP</span>
                      </label>
                      {browserProxyError && (
                        <span className="text-xs text-destructive">{browserProxyError}</span>
                      )}
                    </div>
                    {/* Browser panel — fills remaining height */}
                    {activeSerial ? (
                      <div className="flex-1 min-h-0 overflow-hidden">
                        <BrowserPanel
                          profileId={serialToBrowserId(activeSerial)}
                          userAgent=""
                          username={activeSerial}
                          embedded
                          forceStream
                        />
                      </div>
                    ) : (
                      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                        No device connected
                      </div>
                    )}
                </div>
                {activeTab === "phonesettings" && (
                  <PhoneSettingsPanel key={activeSerial ?? "no-device"} serial={activeSerial} />
                )}
                {activeTab === "actionlog" && (
                  <ActionLogPanel
                    lines={actionLogLines}
                    onClear={clearActionLogLines}
                  />
                )}
                {activeTab === "metrics" && (
                  <MetricsPanel serial={activeSerial ?? null} actionLogLines={actionLogLines} />
                )}
                {activeTab === "log"     && (
                  <LogPanel
                    lines={logLines}
                    onClear={clearLogLines}
                    serial={activeSerial}
                    addLog={addLog}
                    getVideoSize={() => activeSlotRef.current?.getVideoSize() ?? null}
                    logRecMode={logRecMode}
                    onToggleLogRec={() => {
                      if (logRecMode) {
                        // Stopping: export happens inside LogPanel's handleLogRecordStop
                      } else {
                        // Starting: clear old markers
                        setLogMarkers([]);
                        addLog("📍 Log Record started — click the mirror to place expected-tap markers (cyan). Bot taps auto-marked orange.");
                      }
                      setLogRecMode(v => !v);
                    }}
                    logMarkers={logMarkers}
                    phoneDims={phoneDims}
                    inspectMode={inspectMode}
                    onToggleInspect={() => setInspectMode(v => !v)}
                    onScanTray={activeSerial ? async () => {
                      addLog("── Capturing screen layout… ──");
                      try {
                        const r = await fetch(`/api/mobile/devices/${encodeURIComponent(activeSerial)}/screen-layout-scan`);
                        const body = await r.json();
                        if (!r.ok) { addLog(`Capture failed: ${body?.error ?? r.status}`); return []; }
                        for (const line of (body.lines as string[])) addLog(line);
                        return body.lines as string[];
                      } catch (e: any) { addLog(`Capture error: ${e?.message ?? "network error"}`); return []; }
                    } : undefined}
                    onBack={prevLogLocation ? () => {
                      const { tab, slotIdx } = prevLogLocation;
                      setActiveTab(tab);
                      if (tab === "account") {
                        accountPanelRef.current?.backToSlot(slotIdx);
                      }
                    } : undefined}
                  />
                )}
              </div>
            </div>
          </div>
      </main>
    </div>
  );
}
