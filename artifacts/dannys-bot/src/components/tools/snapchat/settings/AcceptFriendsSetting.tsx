import type { AcceptFriendsSettings } from "@/pages/snapchatSettings/acceptFriends";
import { ActionDelayRange } from "./ActionDelayRange";
import { ToolSettingFrame } from "./ToolSettingFrame";
import { useEffect, useRef, useState } from "react";

type AcceptFriendsSettingProps = {
  value: AcceptFriendsSettings;
  loading: boolean;
  phoneSerial?: string;
  onUpdate: (patch: Partial<AcceptFriendsSettings>) => void;
};

const ACCEPT_FRIENDS_SCROLL_PATH_EVENT = "device-accept-friends-scroll-path-change";
const isValidAcceptFriendsScrollPath = (value: string) =>
  /^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 999;

export function AcceptFriendsSetting({ value, loading, phoneSerial, onUpdate }: AcceptFriendsSettingProps) {
  const [scrollPath, setScrollPath] = useState("125");
  const [scrollPathLoaded, setScrollPathLoaded] = useState(false);
  const [scrollPathError, setScrollPathError] = useState("");
  const scrollPathTimerRef = useRef<number | undefined>(undefined);
  const pendingScrollPathRef = useRef<{ serial: string; value: string } | null>(null);
  const scrollPathQueueRef = useRef<Promise<void>>(Promise.resolve());
  const scrollPathSaveSequenceRef = useRef(0);
  const scrollPathEditRevisionRef = useRef(0);
  const currentSerialRef = useRef(phoneSerial ?? "");
  const currentScrollPathRef = useRef("125");
  const savedScrollPathRef = useRef("125");

  const queueScrollPathSave = (serial: string, nextValue: string) => {
    if (!isValidAcceptFriendsScrollPath(nextValue)) return;
    const sequence = ++scrollPathSaveSequenceRef.current;
    scrollPathQueueRef.current = scrollPathQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const response = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/accept-friends-scroll-path`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scrollPath: Number(nextValue) }),
          keepalive: true,
        });
        if (!response.ok) throw new Error("Could not save the device Scroll Path.");
        if (
          sequence === scrollPathSaveSequenceRef.current &&
          currentSerialRef.current === serial &&
          currentScrollPathRef.current === nextValue
        ) {
          savedScrollPathRef.current = nextValue;
          setScrollPathError("");
          window.dispatchEvent(new CustomEvent(ACCEPT_FRIENDS_SCROLL_PATH_EVENT, {
            detail: { serial, value: nextValue, persisted: true },
          }));
        }
      })
      .catch(error => {
        if (sequence === scrollPathSaveSequenceRef.current && currentSerialRef.current === serial) {
          setScrollPathError(error instanceof Error ? error.message : "Could not save the device Scroll Path.");
        }
      });
  };

  useEffect(() => {
    const serial = phoneSerial ?? "";
    currentSerialRef.current = serial;
    setScrollPath("125");
    currentScrollPathRef.current = "125";
    savedScrollPathRef.current = "125";
    setScrollPathLoaded(false);
    setScrollPathError("");
    if (!serial) return;

    let active = true;
    const revisionAtLoad = scrollPathEditRevisionRef.current;
    void fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/accept-friends-scroll-path`, { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("Could not load the device Scroll Path.");
        return response.json() as Promise<{ scrollPath?: unknown }>;
      })
      .then(result => {
        const loadedValue = result.scrollPath;
        if (!Number.isInteger(loadedValue) || Number(loadedValue) < 1 || Number(loadedValue) > 999) {
          throw new Error("The device returned an invalid Scroll Path.");
        }
        if (!active) return;
        setScrollPathLoaded(true);
        if (scrollPathEditRevisionRef.current === revisionAtLoad) {
          const normalized = String(loadedValue);
          setScrollPath(normalized);
          currentScrollPathRef.current = normalized;
          savedScrollPathRef.current = normalized;
        }
      })
      .catch(error => {
        if (!active) return;
        setScrollPathError(error instanceof Error ? error.message : "Could not load the device Scroll Path.");
      });

    return () => {
      active = false;
      if (scrollPathTimerRef.current !== undefined) {
        window.clearTimeout(scrollPathTimerRef.current);
        scrollPathTimerRef.current = undefined;
      }
      const pending = pendingScrollPathRef.current;
      if (pending?.serial === serial) {
        pendingScrollPathRef.current = null;
        queueScrollPathSave(pending.serial, pending.value);
      }
    };
  }, [phoneSerial]);

  useEffect(() => {
    const onDeviceScrollPathChange = (event: Event) => {
      const detail = (event as CustomEvent<{ serial?: string; value?: string; persisted?: boolean }>).detail;
      if (detail?.serial !== phoneSerial || typeof detail.value !== "string") return;
      scrollPathEditRevisionRef.current += 1;
      currentScrollPathRef.current = detail.value;
      setScrollPath(detail.value);
      if (detail.persisted === true && isValidAcceptFriendsScrollPath(detail.value)) {
        savedScrollPathRef.current = detail.value;
        setScrollPathError("");
      }
    };
    window.addEventListener(ACCEPT_FRIENDS_SCROLL_PATH_EVENT, onDeviceScrollPathChange);
    return () => window.removeEventListener(ACCEPT_FRIENDS_SCROLL_PATH_EVENT, onDeviceScrollPathChange);
  }, [phoneSerial]);

  const updateScrollPath = (rawValue: string) => {
    const nextValue = rawValue.replace(/\D/g, "").slice(0, 3);
    setScrollPath(nextValue);
    currentScrollPathRef.current = nextValue;
    scrollPathEditRevisionRef.current += 1;
    setScrollPathError("");
    if (phoneSerial) {
      window.dispatchEvent(new CustomEvent(ACCEPT_FRIENDS_SCROLL_PATH_EVENT, {
        detail: { serial: phoneSerial, value: nextValue },
      }));
    }

    if (scrollPathTimerRef.current !== undefined) window.clearTimeout(scrollPathTimerRef.current);
    pendingScrollPathRef.current = isValidAcceptFriendsScrollPath(nextValue) && phoneSerial
      ? { serial: phoneSerial, value: nextValue }
      : null;
    if (pendingScrollPathRef.current) {
      scrollPathTimerRef.current = window.setTimeout(() => {
        scrollPathTimerRef.current = undefined;
        const pending = pendingScrollPathRef.current;
        pendingScrollPathRef.current = null;
        if (pending) queueScrollPathSave(pending.serial, pending.value);
      }, 250);
    }
  };

  const flushScrollPathSave = () => {
    if (scrollPathTimerRef.current !== undefined) {
      window.clearTimeout(scrollPathTimerRef.current);
      scrollPathTimerRef.current = undefined;
    }
    const pending = pendingScrollPathRef.current;
    pendingScrollPathRef.current = null;
    if (pending) queueScrollPathSave(pending.serial, pending.value);
    else if (phoneSerial && isValidAcceptFriendsScrollPath(scrollPath) && scrollPath !== savedScrollPathRef.current) {
      queueScrollPathSave(phoneSerial, scrollPath);
    } else if (!isValidAcceptFriendsScrollPath(scrollPath)) {
      setScrollPath(savedScrollPathRef.current);
      currentScrollPathRef.current = savedScrollPathRef.current;
      window.dispatchEvent(new CustomEvent(ACCEPT_FRIENDS_SCROLL_PATH_EVENT, {
        detail: { serial: phoneSerial, value: savedScrollPathRef.current },
      }));
    }
  };

  return (
    <ToolSettingFrame
      title="Accept Friends"
      countLabel="Count"
      countFloor={0}
      value={value}
      loading={loading}
      onUpdate={onUpdate}
      children={
        <ActionDelayRange
          minSeconds={value.delayMinSeconds}
          maxSeconds={value.delayMaxSeconds}
          disabled={loading || !value.enabled}
          onChange={onUpdate}
        />
      }
      childrenBelow={
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`accept-friends-scroll-path-${phoneSerial ?? "device"}`} className="text-xs text-muted-foreground">
            Scroll Path
          </label>
          <input
            id={`accept-friends-scroll-path-${phoneSerial ?? "device"}`}
              data-testid={`input-accept-friends-scroll-path-${phoneSerial ?? "device"}`}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={3}
            value={scrollPath}
            onChange={event => updateScrollPath(event.target.value)}
            onBlur={flushScrollPathSave}
            disabled={!phoneSerial || !scrollPathLoaded}
            aria-label="Device-specific Accept Friends scroll path in pixels"
            className="h-7 w-12 rounded-md border border-input bg-background px-1 text-center text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span className="text-xs text-muted-foreground">px · device-specific</span>
          {scrollPathError && <span role="alert" className="text-xs text-destructive">{scrollPathError}</span>}
        </div>
      }
    />
  );
}
