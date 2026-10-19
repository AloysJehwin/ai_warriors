import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadActor, ROLE_LABEL, saveActor, type Actor } from "./api";
import { connect, useLive } from "./live";
import { ApprovalsPage } from "./pages/Approvals";
import { IncidentPage, IncidentsPage } from "./pages/Incidents";
import { LedgerPage } from "./pages/Ledger";
import { LinePage } from "./pages/Line";
import { SystemPage } from "./pages/System";
import { VerifyPage } from "./pages/Verify";
import type { Role } from "./types";
import "./styles.css";

function useHash(): string {
  const [h, setH] = useState(location.hash || "#/line");
  useEffect(() => {
    const on = () => setH(location.hash || "#/line");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return h;
}

const NAV = [
  { href: "#/line", label: "Line", icon: "M3 17h4l3-8 4 12 3-6h4" },
  { href: "#/incidents", label: "Incidents", icon: "M12 3l9 16H3zM12 10v4M12 17h.01" },
  { href: "#/approvals", label: "Approvals", icon: "M4 12l5 5L20 6" },
  { href: "#/ledger", label: "Audit ledger", icon: "M5 4h14v16H5zM9 8h6M9 12h6M9 16h4" },
  { href: "#/verify", label: "Verify", icon: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" },
  { href: "#/system", label: "System", icon: "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12h2M3 12h2M12 3v2M12 19v2M17 7l1.5-1.5M5.5 18.5L7 17M17 17l1.5 1.5M5.5 5.5L7 7" },
];

function App() {
  const live = useLive();
  const hash = useHash();
  const [actor, setActor] = useState<Actor>(loadActor);
  useEffect(connect, []);
  const pending = Object.values(live.approvals).filter((a) => a.status === "pending").length;
  const open = Object.values(live.incidents).filter((i) => i.status !== "closed").length;
  const [, route, param] = hash.split("/");

  let page;
  if (route === "incidents" && param) page = <IncidentPage id={param} live={live} actor={actor} />;
  else if (route === "incidents") page = <IncidentsPage live={live} />;
  else if (route === "approvals") page = <ApprovalsPage live={live} actor={actor} />;
  else if (route === "ledger") page = <LedgerPage live={live} />;
  else if (route === "verify") page = <VerifyPage id={param ?? null} live={live} />;
  else if (route === "system") page = <SystemPage live={live} />;
  else page = <LinePage live={live} actor={actor} />;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <b>Ordo</b>
          <div className="eyebrow">Autonomous orchestration</div>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} className={`#/${route}` === n.href ? "active" : ""}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={n.icon} />
              </svg>
              {n.label}
              {n.href === "#/approvals" && pending > 0 && <span className="count">{pending}</span>}
              {n.href === "#/incidents" && open > 0 && <span className="count">{open}</span>}
            </a>
          ))}
        </nav>
        <div className="foot">
          <div className="label">Acting as</div>
          <select aria-label="Acting as" value={actor.role} onChange={(e) => setActor(saveActor(e.target.value as Role))} data-testid="acting-as">
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          <div className="faint" style={{ fontSize: 12 }}>
            {actor.name} · demo identity
          </div>
          {live.plant && (
            <div className="faint" style={{ fontSize: 12, lineHeight: 1.6 }}>
              <div>
                <span className={`dot`} style={{ color: live.connected ? "var(--ok)" : "var(--bad)" }} /> {live.connected ? "live" : "reconnecting"}
              </div>
              <div>AI: {live.plant.mode.llm}</div>
              <div>Anchor: {live.plant.mode.anchor}</div>
              <div>Payments: {live.plant.mode.payments}</div>
              {live.status?.build && <div>Env: {live.status.build.env}</div>}
            </div>
          )}
        </div>
      </aside>
      <main className="main">{page}</main>
      <div className="toast" role="status" aria-live="polite">
        {live.alerts.map((a) => (
          <div key={a.id}>{a.message}</div>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
