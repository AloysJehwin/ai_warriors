import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "ordo.theme";
const dark = () => window.matchMedia?.("(prefers-color-scheme: dark)");

/** The person's explicit pick, or null to follow the system. */
const stored = (): Theme | null => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
};
const system = (): Theme => (dark()?.matches ? "dark" : "light");

/** The theme on screen. Starts from the system preference; a pick is remembered and wins from then on. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => stored() ?? system());
  useEffect(() => {
    const mq = dark();
    if (!mq) return;
    const onChange = () => {
      if (!stored()) setThemeState(system());
    };
    mq.addEventListener("change", onChange);
    // keep every toggle on the page in step
    const onPick = (e: Event) => setThemeState((e as CustomEvent<Theme>).detail);
    window.addEventListener("ordo-theme", onPick);
    return () => {
      mq.removeEventListener("change", onChange);
      window.removeEventListener("ordo-theme", onPick);
    };
  }, []);
  const setTheme = (t: Theme) => {
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* ignore */
    }
    document.documentElement.dataset.theme = t;
    window.dispatchEvent(new CustomEvent("ordo-theme", { detail: t }));
  };
  return [theme, setTheme];
}
