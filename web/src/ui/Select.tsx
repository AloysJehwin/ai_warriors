import { useMemo, useRef, useState, type ReactNode } from "react";
import { useDismiss, useId } from "./hooks";

export interface Option<V extends string = string> {
  value: V;
  label: string;
  hint?: string;
  group?: string;
  disabled?: boolean;
  icon?: ReactNode;
}

/**
 * Ordo's dropdown: a button that opens a listbox. Keyboard: ↑/↓ to move, Enter to choose,
 * Esc to close, type to filter (when searchable) or jump to the first match.
 */
export function Select<V extends string>(props: {
  value: V | null;
  onChange: (v: V) => void;
  options: Option<V>[];
  placeholder?: string;
  searchable?: boolean;
  disabled?: boolean;
  width?: number | string;
  label?: string;
  size?: "sm" | "md";
  align?: "left" | "right";
  emptyText?: string;
}) {
  const { value, onChange, options, placeholder = "Select…", disabled, width, label, size = "md", align = "left", emptyText = "No matches" } = props;
  const searchable = props.searchable ?? options.length > 8;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId("sel");
  const current = options.find((o) => o.value === value) ?? null;
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => `${o.label} ${o.hint ?? ""} ${o.group ?? ""}`.toLowerCase().includes(s)) : options;
  }, [options, q]);
  useDismiss(open, [wrap], () => setOpen(false));

  const openList = () => {
    if (disabled) return;
    setQ("");
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const choose = (o: Option<V> | undefined) => {
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
  };
  const move = (d: number) => {
    if (!filtered.length) return;
    let i = active;
    for (let n = 0; n < filtered.length; n++) {
      i = (i + d + filtered.length) % filtered.length;
      if (!filtered[i]!.disabled) break;
    }
    setActive(i);
    listRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === "ArrowDown") (e.preventDefault(), move(1));
    else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
    else if (e.key === "Home") (e.preventDefault(), setActive(0));
    else if (e.key === "End") (e.preventDefault(), setActive(filtered.length - 1));
    else if (e.key === "Enter") (e.preventDefault(), choose(filtered[active]));
    else if (e.key === "Tab") setOpen(false);
    else if (!searchable && e.key.length === 1) {
      const i = filtered.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (i >= 0) setActive(i);
    }
  };

  let lastGroup: string | undefined;
  return (
    <div className={`sel ${size}`} ref={wrap} style={{ width }} onKeyDown={onKey}>
      {label && <span className="sel-label">{label}</span>}
      <button type="button" className="sel-btn" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-controls={id} onClick={() => (open ? setOpen(false) : openList())}>
        {current?.icon}
        <span className={current ? "" : "faint"}>{current?.label ?? placeholder}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="chev">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      {open && (
        <div className={`sel-pop ${align}`}>
          {searchable && <input autoFocus className="sel-search" placeholder="Search…" value={q} onChange={(e) => (setQ(e.target.value), setActive(0))} aria-label="Filter options" />}
          <ul role="listbox" id={id} ref={listRef} tabIndex={-1} aria-activedescendant={`${id}-${active}`}>
            {filtered.length === 0 && <li className="sel-empty">{emptyText}</li>}
            {filtered.map((o, i) => {
              const head = o.group && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              return (
                <li key={o.value} role="presentation">
                  {head && <div className="sel-group">{head}</div>}
                  <div
                    role="option"
                    id={`${id}-${i}`}
                    data-i={i}
                    aria-selected={o.value === value}
                    aria-disabled={o.disabled}
                    className={`sel-opt${i === active ? " active" : ""}${o.value === value ? " chosen" : ""}${o.disabled ? " disabled" : ""}`}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => choose(o)}
                  >
                    {o.icon}
                    <span className="sel-text">
                      <span>{o.label}</span>
                      {o.hint && <span className="sel-hint">{o.hint}</span>}
                    </span>
                    {o.value === value && (
                      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="tick">
                        <path d="M3 7.5 6 10.5 11 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
                      </svg>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
