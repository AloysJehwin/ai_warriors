import { useEffect, useRef, type RefObject } from "react";

/** Calls `onOutside` on a pointer-down outside any of the refs, or on Escape. */
export function useDismiss(open: boolean, refs: RefObject<HTMLElement | null>[], onOutside: () => void) {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (refs.some((r) => r.current?.contains(e.target as Node))) return;
      cb.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") cb.current();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

let uid = 0;
export const useId = (p: string) => {
  const r = useRef<string | null>(null);
  r.current ??= `${p}-${++uid}`;
  return r.current;
};
