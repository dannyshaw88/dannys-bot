import { useEffect, useRef, RefObject } from "react";

/**
 * Saves the scroll position of `ref` (or `#app-scroll`) to sessionStorage on
 * unmount, and restores it once `ready` is true (e.g. after async data loads).
 *
 * WHY the mutable-ref approach:
 * In React 18, element refs (e.g. scrollBodyRef.current) are set to null
 * BEFORE passive useEffect cleanups run during unmount.  Reading
 * `ref.current` inside a cleanup therefore always returns null, causing the
 * save to silently fall back to #app-scroll (which is at 0).
 *
 * Fix: keep a plain useRef<number> updated via a scroll event listener so the
 * cleanup reads a number — never a DOM element ref that may already be null.
 */
export function useScrollRestore(
  key: string,
  ref?: RefObject<HTMLElement | null>,
  ready = true,
) {
  const latestTop = useRef(0);

  // ── 1. Track scroll position in real-time ──────────────────────────────────
  // Fires (and re-fires) whenever `ready` changes so the listener is attached
  // to the right element once data has loaded and the DOM is populated.
  useEffect(() => {
    const el = ref?.current ?? document.getElementById("app-scroll");
    if (!el) return;
    latestTop.current = el.scrollTop;
    const handler = () => { latestTop.current = el.scrollTop; };
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 2. Save on unmount ─────────────────────────────────────────────────────
  // Reads the mutable number ref — safe even though el refs are null by now.
  useEffect(() => {
    return () => {
      sessionStorage.setItem(`scroll:${key}`, String(latestTop.current));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 3. Restore once data is ready ─────────────────────────────────────────
  // Runs after the scroll-listener effect (same [ready] dep, declared later)
  // so latestTop is immediately updated to match the restored position.
  useEffect(() => {
    if (!ready) return;
    const el = ref?.current ?? document.getElementById("app-scroll");
    if (!el) return;
    const saved = sessionStorage.getItem(`scroll:${key}`);
    if (saved) {
      el.scrollTop = Number(saved);
      latestTop.current = Number(saved); // keep mutable ref in sync after restore
    }
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps
}
