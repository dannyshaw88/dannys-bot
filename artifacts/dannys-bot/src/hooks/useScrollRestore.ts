import { useEffect, RefObject } from "react";

export function useScrollRestore(key: string, ref?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref?.current ?? document.getElementById("app-scroll");
    if (!el) return;
    const saved = sessionStorage.getItem(`scroll:${key}`);
    if (saved) el.scrollTop = Number(saved);
    return () => {
      sessionStorage.setItem(`scroll:${key}`, String(el.scrollTop));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
