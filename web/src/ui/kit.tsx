import { cloneElement, createContext, useCallback, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "./hooks";

export function Segmented<V extends string>(props: { value: V; onChange: (v: V) => void; options: { value: V; label: string; count?: number }[]; size?: "sm" | "md"; label?: string }) {
  return (
    <div className={`seg ${props.size ?? "md"}`} role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button type="button" key={o.value} role="radio" aria-checked={o.value === props.value} className={o.value === props.value ? "on" : ""} onClick={() => props.onChange(o.value)}>
          {o.label}
          {o.count !== undefined && <span className="seg-n">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Tabs<V extends string>(props: { value: V; onChange: (v: V) => void; tabs: { value: V; label: string; count?: number }[] }) {
  return (
    <div className="tabs" role="tablist">
      {props.tabs.map((t) => (
        <button type="button" key={t.value} role="tab" aria-selected={t.value === props.value} className={t.value === props.value ? "on" : ""} onClick={() => props.onChange(t.value)}>
          {t.label}
          {t.count !== undefined && <span className="tab-n">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

function useLockScroll(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);
}

export function Modal(props: { open: boolean; onClose: () => void; title: string; eyebrow?: string; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLockScroll(props.open);
  useEffect(() => {
    if (!props.open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    document.addEventListener("keydown", k);
    ref.current?.querySelector<HTMLElement>("input, textarea, button.sel-btn, button")?.focus();
    return () => document.removeEventListener("keydown", k);
  }, [props.open, props.onClose]);
  if (!props.open) return null;
  return createPortal(
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={props.title} ref={ref} style={{ maxWidth: props.width ?? 560 }}>
        <div className="modal-h">
          <div>
            {props.eyebrow && <div className="eyebrow">{props.eyebrow}</div>}
            <h2>{props.title}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div className="modal-b">{props.children}</div>
        {props.footer && <div className="modal-f">{props.footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer(props: { open: boolean; onClose: () => void; title: ReactNode; eyebrow?: ReactNode; children: ReactNode; width?: number; actions?: ReactNode }) {
  useLockScroll(props.open);
  useEffect(() => {
    if (!props.open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [props.open, props.onClose]);
  if (!props.open) return null;
  return createPortal(
    <div className="overlay drawer-overlay" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" style={{ width: props.width ?? 440 }}>
        <div className="modal-h">
          <div>
            {props.eyebrow && <div className="eyebrow">{props.eyebrow}</div>}
            <h2>{props.title}</h2>
          </div>
          <div className="btns">
            {props.actions}
            <button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose}>
              ×
            </button>
          </div>
        </div>
        <div className="drawer-b">{props.children}</div>
      </aside>
    </div>,
    document.body,
  );
}

/** A small menu anchored to its trigger. */
export function Menu(props: { trigger: (open: boolean, toggle: () => void) => ReactNode; items: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }[]; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, [ref], () => setOpen(false));
  return (
    <div className="menu" ref={ref}>
      {props.trigger(open, () => setOpen(!open))}
      {open && (
        <div className={`pop menu-pop ${props.align ?? "right"}`} role="menu">
          {props.items.map((i) => (
            <button type="button" role="menuitem" key={i.label} disabled={i.disabled} className={i.danger ? "danger" : ""} onClick={() => (setOpen(false), i.onClick())}>
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- Toasts ----------------
type Toast = { id: number; text: string; kind: "ok" | "bad" | "info" };
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-3), { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === "bad" ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => setItems((x) => x.filter((y) => y.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------------- Small pieces ----------------
export const Empty = (p: { title: string; children?: ReactNode; action?: ReactNode }) => (
  <div className="empty-state">
    <div className="empty-mark" aria-hidden>
      <svg width="36" height="36" viewBox="0 0 36 36">
        <circle cx="10" cy="18" r="5" fill="none" stroke="currentColor" />
        <circle cx="26" cy="10" r="4" fill="none" stroke="currentColor" strokeDasharray="2 2" />
        <circle cx="26" cy="26" r="4" fill="none" stroke="currentColor" strokeDasharray="2 2" />
        <path d="M15 16 22 11M15 20l7 5" stroke="currentColor" fill="none" />
      </svg>
    </div>
    <h3>{p.title}</h3>
    {p.children && <p className="muted">{p.children}</p>}
    {p.action}
  </div>
);

/** A labelled form row. Plain inputs get the label via aria-label; custom controls sit in a named group. */
export const Field = (p: { label: string; hint?: ReactNode; children: ReactNode; error?: string | null }) => {
  const child = p.children as { type?: unknown; props?: Record<string, unknown> };
  const plain = child && (child.type === "input" || child.type === "textarea");
  const content = plain && !child.props?.["aria-label"] ? cloneElement(p.children as ReactElement<Record<string, unknown>>, { "aria-label": p.label }) : p.children;
  return (
    <div className="field" role="group" aria-label={p.label}>
      <span className="field-l">{p.label}</span>
      {content}
      {p.hint && !p.error && <span className="field-h">{p.hint}</span>}
      {p.error && <span className="field-e">{p.error}</span>}
    </div>
  );
};

export const Spinner = () => <span className="spinner" aria-label="Loading" />;

export function Loading({ text = "Loading…" }: { text?: string }) {
  return (
    <div className="loading">
      <Spinner /> {text}
    </div>
  );
}

/** Async button: disables itself while the action runs and reports errors as a toast. */
export function Action(props: { onClick: () => Promise<unknown> | unknown; children: ReactNode; className?: string; disabled?: boolean; title?: string; type?: "button" | "submit" }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <button
      type={props.type ?? "button"}
      title={props.title}
      className={props.className ?? "btn"}
      disabled={props.disabled || busy}
      onClick={async () => {
        setBusy(true);
        try {
          await props.onClick();
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e), "bad");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Spinner /> : null}
      {props.children}
    </button>
  );
}

export function Icon({ name }: { name: string }) {
  const p: Record<string, ReactNode> = {
    pipelines: <path d="M2 5h3v3H2zM11 2h3v3h-3zM11 11h3v3h-3zM5 6.5h2.5V3.5H11M7.5 6.5v6H11" />,
    validation: <path d="M8 1.5 13.5 4v4c0 3.2-2.4 5.6-5.5 6.5C4.9 13.6 2.5 11.2 2.5 8V4zM5.5 8l1.8 1.8L10.8 6.3" />,
    templates: <path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" />,
    history: <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3.2l2.2 1.4" />,
    floor: <path d="M1.5 14.5h13M2.5 14.5V8l3 2V8l3 2V5l3 2v7.5M11.5 4V1.5h2v5" />,
    approvals: <path d="M1.5 9.5 3.5 3h9l2 6.5V14h-13zM1.5 9.5h4l1 2h3l1-2h4" />,
    builder: <path d="M2 4h7M12 4h2M2 12h2M7 12h7M9 2.5v3M5 10.5v3" />,
    team: <path d="M5.5 7a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM1.5 13.5c.4-2.4 2-3.8 4-3.8s3.6 1.4 4 3.8M11 7.3a1.9 1.9 0 1 0 0-3.8M11.5 9.8c1.6.3 2.6 1.6 3 3.7" />,
    proof: <path d="M4.5 6V4.5a3.5 3.5 0 0 1 7 0V6M3 6h10v8H3zM8 9v2.5" />,
    settings: <path d="M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />,
  };
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {p[name]}
    </svg>
  );
}
