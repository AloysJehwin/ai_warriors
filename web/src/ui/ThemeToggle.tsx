import { useTheme } from "../lib/theme";

/** Flips between light and dark. `floating` pins it to the corner on pages without the sidebar. */
export function ThemeToggle({ floating }: { floating?: boolean }) {
  const [theme, setTheme] = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" className={`icon-btn theme-toggle${floating ? " theme-float" : ""}`} onClick={() => setTheme(next)} title={`Switch to ${next} theme`} aria-label={`Switch to ${next} theme`}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {theme === "dark" ? (
          <path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
        ) : (
          <path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1z" />
        )}
      </svg>
    </button>
  );
}
