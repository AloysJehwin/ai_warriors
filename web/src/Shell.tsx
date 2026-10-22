import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { useApp } from "./lib/app";
import { LEVEL_LABEL, shortAddr } from "./lib/format";
import { href, useRoute } from "./lib/router";
import { Field, Icon, Menu, Modal, useToast } from "./ui/kit";
import { ThemeToggle } from "./ui/ThemeToggle";
import { Approvals } from "./pages/Approvals";
import { Builder } from "./pages/Builder";
import { Finance } from "./pages/Finance";
import { Floor } from "./pages/Floor";
import { History } from "./pages/History";
import { Pipelines } from "./pages/Pipelines";
import { Proof } from "./pages/Proof";
import { Settings } from "./pages/Settings";
import { TeamPage } from "./pages/Team";
import { Templates } from "./pages/Templates";
import { Validation } from "./pages/Validation";
import { WorkOrders } from "./pages/WorkOrders";

type Count = "approvals" | "validation" | "onboarding" | "workOrders" | "autonomy";
const NAV: { page: string; label: string; icon: string; count?: Count }[] = [
  { page: "pipelines", label: "Pipelines", icon: "pipelines" },
  { page: "validation", label: "Validation", icon: "validation", count: "validation" },
  { page: "templates", label: "Templates", icon: "templates" },
  { page: "history", label: "Run history", icon: "history" },
  { page: "floor", label: "Floor & fleet", icon: "floor" },
  { page: "approvals", label: "Approvals", icon: "approvals", count: "approvals" },
  { page: "work-orders", label: "Work orders", icon: "workorders", count: "workOrders" },
  { page: "finance", label: "Pay on proof", icon: "finance" },
  { page: "builder", label: "Builder", icon: "builder" },
];
const ADMIN_NAV: { page: string; label: string; icon: string; count?: Count }[] = [
  { page: "team", label: "Team & validators", icon: "team", count: "onboarding" },
  { page: "proof", label: "Proof & ledger", icon: "proof" },
  { page: "settings", label: "Settings", icon: "settings", count: "autonomy" },
];

function Clock({ tz }: { tz: string }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return <>{now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: tz })} local</>;
}

export function Shell({ onSignOut, onSwitchAccount, onSwitchSite }: { onSignOut: () => void; onSwitchAccount: () => void; onSwitchSite: (id: string) => void }) {
  const { site, live, me, setMe } = useApp();
  const route = useRoute();
  const toast = useToast();
  const [rename, setRename] = useState<string | null>(null);
  const line = site.lines[0];
  const agentsWithAssets = new Set((live?.assets ?? []).map((a) => a.owningAgent)).size;
  const user = me.user!;
  const display = user.displayName ?? user.ens ?? shortAddr(user.address);

  let page: ReactNode;
  switch (route.page) {
    case "validation":
      page = <Validation />;
      break;
    case "templates":
      page = <Templates />;
      break;
    case "history":
      page = <History />;
      break;
    case "floor":
      page = <Floor />;
      break;
    case "approvals":
      page = <Approvals />;
      break;
    case "builder":
      page = <Builder />;
      break;
    case "team":
      page = <TeamPage />;
      break;
    case "proof":
      page = <Proof />;
      break;
    case "settings":
      page = <Settings />;
      break;
    case "work-orders":
      page = <WorkOrders />;
      break;
    case "finance":
      page = <Finance />;
      break;
    default:
      page = <Pipelines />;
  }
  const navItem = (n: { page: string; label: string; icon: string; count?: Count }) => {
    const c = n.count && live ? (live.counts[n.count] ?? 0) : 0;
    return (
      <a key={n.page} href={href(n.page)} className={route.page === n.page || (route.page === "pipelines" && n.page === "pipelines") ? "active" : ""}>
        <Icon name={n.icon} />
        {n.label}
        {c > 0 && <span className="count">{c}</span>}
      </a>
    );
  };
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <div className="brand-row">
            <b>Ordo</b>
            <ThemeToggle />
          </div>
          <span className="eyebrow">Autonomous orchestration</span>
        </div>
        <nav className="nav" aria-label="Main">
          {NAV.map(navItem)}
          <div className="nav-sep" />
          {ADMIN_NAV.map(navItem)}
        </nav>
        <div className="foot">
          <div>
            <div className="label">Site</div>
            <div className="site-name">
              {site.name}
              {line ? ` · ${line.name}` : ""}
            </div>
            <div className="small muted">
              <Clock tz={site.timezone} />
            </div>
          </div>
          {line && (
            <div>
              <div className="label">Autonomy</div>
              <div className="accent-text">
                {line.autonomy} · {LEVEL_LABEL[line.autonomy]}
              </div>
              <div className="small muted">
                {agentsWithAssets} agents with assets · {live?.assets.length ?? 0} assets
              </div>
            </div>
          )}
          <Menu
            align="left"
            trigger={(_o, toggle) => (
              <button type="button" className="user-chip" onClick={toggle}>
                <span className="avatar" style={{ background: `hsl(${parseInt(user.address.slice(2, 8), 16) % 360} 45% 82%)` }}>{user.displayName || user.ens ? display.slice(0, 1).toUpperCase() : ""}</span>
                <span className="user-text">
                  <span>{display}</span>
                  <span className="faint small">{site.myRoles.map((r) => r.replaceAll("_", " ")).join(", ")}</span>
                </span>
              </button>
            )}
            items={[
              { label: "Set display name", onClick: () => setRename(user.displayName ?? "") },
              ...me.memberships.filter((m) => m.siteId !== site.id).map((m) => ({ label: `Switch to ${m.siteName}`, onClick: () => onSwitchSite(m.siteId) })),
              { label: "Switch account", onClick: onSwitchAccount },
              { label: "Sign out", onClick: onSignOut, danger: true },
            ]}
          />
        </div>
      </aside>
      <main className="main">{page}</main>
      <Modal
        open={rename !== null}
        onClose={() => setRename(null)}
        title="Display name"
        footer={
          <div className="btns end">
            <button type="button" className="btn" onClick={() => setRename(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn accent"
              disabled={!rename?.trim()}
              onClick={async () => {
                try {
                  setMe(await api.patch("/v1/me", { displayName: rename }));
                  setRename(null);
                  toast("Name saved", "ok");
                } catch (e) {
                  toast(String(e instanceof Error ? e.message : e), "bad");
                }
              }}
            >
              Save
            </button>
          </div>
        }
      >
        <Field label="Shown to your team instead of your address" hint="Your wallet address stays the identity behind every signature.">
          <input className="input" value={rename ?? ""} onChange={(e) => setRename(e.target.value)} maxLength={60} />
        </Field>
      </Modal>
    </div>
  );
}
