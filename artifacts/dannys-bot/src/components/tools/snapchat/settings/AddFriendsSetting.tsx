import type { AddFriendsSettings } from "@/pages/snapchatSettings/addFriends";
import { ActionDelayRange } from "./ActionDelayRange";
import { ToolSettingFrame } from "./ToolSettingFrame";
import { useEffect, useRef, useState } from "react";
import { FileText, Upload } from "lucide-react";

type AddFriendsSettingProps = {
  value: AddFriendsSettings;
  loading: boolean;
  phoneSerial?: string;
  onUpdate: (patch: Partial<AddFriendsSettings>) => void;
};

const ADD_FRIENDS_SCROLL_PATH_EVENT = "device-add-friends-scroll-path-change";
const isValidScrollPath = (value: string) => /^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 999;

export function AddFriendsSetting({ value, loading, phoneSerial, onUpdate }: AddFriendsSettingProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState("");
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
  const avoidWords = typeof value.avoidUsersContainingWords === "string" ? value.avoidUsersContainingWords : "";
  const fileName = typeof value.avoidUsersContainingFileName === "string" ? value.avoidUsersContainingFileName : "";
  const termCount = avoidWords
    .split(",")
    .filter(term => term.trim()).length;

  const queueScrollPathSave = (serial: string, nextValue: string) => {
    if (!isValidScrollPath(nextValue)) return;
    const sequence = ++scrollPathSaveSequenceRef.current;
    scrollPathQueueRef.current = scrollPathQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const response = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/add-friends-scroll-path`, {
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
          window.dispatchEvent(new CustomEvent(ADD_FRIENDS_SCROLL_PATH_EVENT, {
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
    void fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/add-friends-scroll-path`, { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("Scroll Path request failed.");
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
        console.warn("[Add Friends] Scroll Path read failed; using the 125 px default.", error);
        setScrollPath("125");
        currentScrollPathRef.current = "125";
        savedScrollPathRef.current = "125";
        setScrollPathLoaded(true);
        setScrollPathError("");
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
      if (detail.persisted === true && isValidScrollPath(detail.value)) {
        savedScrollPathRef.current = detail.value;
        setScrollPathError("");
      }
    };
    window.addEventListener(ADD_FRIENDS_SCROLL_PATH_EVENT, onDeviceScrollPathChange);
    return () => window.removeEventListener(ADD_FRIENDS_SCROLL_PATH_EVENT, onDeviceScrollPathChange);
  }, [phoneSerial]);

  const updateScrollPath = (rawValue: string) => {
    const nextValue = rawValue.replace(/\D/g, "").slice(0, 3);
    setScrollPath(nextValue);
    currentScrollPathRef.current = nextValue;
    scrollPathEditRevisionRef.current += 1;
    setScrollPathError("");
    if (phoneSerial) {
      window.dispatchEvent(new CustomEvent(ADD_FRIENDS_SCROLL_PATH_EVENT, {
        detail: { serial: phoneSerial, value: nextValue },
      }));
    }

    if (scrollPathTimerRef.current !== undefined) window.clearTimeout(scrollPathTimerRef.current);
    pendingScrollPathRef.current = isValidScrollPath(nextValue) && phoneSerial
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
    else if (phoneSerial && isValidScrollPath(scrollPath) && scrollPath !== savedScrollPathRef.current) {
      queueScrollPathSave(phoneSerial, scrollPath);
    } else if (!isValidScrollPath(scrollPath)) {
      setScrollPath(savedScrollPathRef.current);
      currentScrollPathRef.current = savedScrollPathRef.current;
      window.dispatchEvent(new CustomEvent(ADD_FRIENDS_SCROLL_PATH_EVENT, {
        detail: { serial: phoneSerial, value: savedScrollPathRef.current },
      }));
    }
  };

  const loadAvoidWordsFile = async (file?: File) => {
    if (!file) return;
    setFileError("");
    if (!file.name.toLowerCase().endsWith(".txt") && file.type !== "text/plain") {
      setFileError("Choose a .txt file.");
      return;
    }
    if (file.size > 1_000_000) {
      setFileError("The text file must be 1 MB or smaller.");
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim()) {
        setFileError("The selected text file is empty.");
        return;
      }
      onUpdate({
        avoidUsersContainingWords: text,
        avoidUsersContainingFileName: file.name.slice(0, 255),
      });
    } catch {
      setFileError("Could not read the selected text file.");
    }
  };

  return (
    <ToolSettingFrame
      title="Add Friends"
      countLabel="Count"
      countFloor={0}
      value={value}
      loading={loading}
      onUpdate={onUpdate}
      children={
        <>
          <ActionDelayRange
            minSeconds={value.delayMinSeconds}
            maxSeconds={value.delayMaxSeconds}
            disabled={loading || !value.enabled}
            onChange={onUpdate}
          />
          <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={value.skipAdded}
              onChange={event => onUpdate({ skipAdded: event.target.checked })}
              disabled={loading || !value.enabled}
              className="h-4 w-4 accent-primary"
            />
            Skip Added
          </label>
        </>
      }
      childrenBelow={
        <div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={value.avoidUsersContainingEnabled}
                onChange={event => onUpdate({ avoidUsersContainingEnabled: event.target.checked })}
                disabled={loading || !value.enabled}
                className="h-4 w-4 accent-primary"
              />
              Avoid Users Containing:
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,text/plain"
              className="hidden"
              disabled={loading || !value.enabled}
              onChange={event => {
                void loadAvoidWordsFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading || !value.enabled}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {fileName ? <FileText className="h-3.5 w-3.5" /> : <Upload className="h-3.5 w-3.5" />}
              {fileName || "Upload text file"}
            </button>
            {fileName && (
              <span className="text-xs text-muted-foreground">
                {termCount.toLocaleString()} words
              </span>
            )}
            {fileError && <span role="alert" className="text-xs text-destructive">{fileError}</span>}
            <label htmlFor={`add-friends-scroll-path-${phoneSerial ?? "device"}`} className="text-xs text-muted-foreground">
              Scroll Path
            </label>
            <input
              id={`add-friends-scroll-path-${phoneSerial ?? "device"}`}
              data-testid={`input-add-friends-scroll-path-${phoneSerial ?? "device"}`}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={3}
              value={scrollPath}
              onChange={event => updateScrollPath(event.target.value)}
              onBlur={flushScrollPathSave}
              disabled={!phoneSerial || !scrollPathLoaded}
              aria-label="Add Friends scroll path in pixels"
              className="h-7 w-12 rounded-md border border-input bg-background px-1 text-center text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            />
            <span className="text-xs text-muted-foreground">px</span>
            {scrollPathError && <span role="alert" className="text-xs text-destructive">{scrollPathError}</span>}
          </div>
        </div>
      }
    />
  );
}
