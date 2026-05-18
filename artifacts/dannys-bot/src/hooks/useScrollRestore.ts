import { useEffect, RefObject } from "react";

/**
 * Saves the scroll position of `ref` (or `#app-scroll`) to sessionStorage on
 * unmount, and restores it once `ready` is true (e.g. after async data loads).
 *
 * Splitting save/restore into two effects is essential: the container must be
 * fully populated before setting scrollTop, otherwise the list isn't tall
 * enough and the assignment is silently clamped to 0.
 */
export function useScrollRestore(
  key: string,
  ref?: RefObject<HTMLElement | null>,
  ready = true,
) {
  // Save on unmount — always, regardless of ready state
  useEffect(() => {
    return () => {
      const el = ref?.current ?? document.getElementById("app-scroll");
      if (el) sessionStorage.setItem(`scroll:${key}`, String(el.scrollTop));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore only once data is ready (list fully rendered)
  useEffect(() => {
    if (!ready) return;
    const el = ref?.current ?? document.getElementById("app-scroll");
    if (!el) return;
    const saved = sessionStorage.getItem(`scroll:${key}`);
    if (saved) el.scrollTop = Number(saved);
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps
}
