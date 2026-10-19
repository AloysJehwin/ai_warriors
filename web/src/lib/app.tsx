import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../api";
import type { DecisionView, InboxItemView, Me, Meta, Role, RunView, Site, Status, Team, TypedSignature } from "../types";
import type { AssetView } from "../types";

export interface Live {
  now: string;
  assets: AssetView[];
  runs: RunView[];
  inbox: InboxItemView[];
  decisions: DecisionView[];
  headSeq: number;
  counts: { approvals: number; validation: number; onboarding: number; workOrders: number; autonomy: number };
}

const RANK: Record<Role, number> = { operator: 1, supervisor: 2, process_engineer: 3, quality_engineer: 3, maintenance_lead: 3, plant_manager: 4, admin: 5 };
export const canAct = (roles: Role[], required: Role) => roles.some((r) => r === required || RANK[r] > RANK[required]);

interface Ctx {
  me: Me;
  setMe: (m: Me) => void;
  site: Site;
  siteId: string;
  meta: Meta;
  status: Status;
  live: Live | null;
  team: Team | null;
  names: Map<string, string>;
  roles: Role[];
  can: (r: Role) => boolean;
  refresh: () => Promise<void>;
  reloadSite: () => Promise<void>;
  path: (p: string) => string;
}
const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error("outside app");
  return c;
};

export function AppProvider(props: { me: Me; setMe: (m: Me) => void; siteId: string; meta: Meta; status: Status; children: ReactNode }) {
  const [site, setSite] = useState<Site | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/v1/sites/${props.siteId}`;
  const busy = useRef(false);

  const reloadSite = useCallback(async () => {
    const [s, t] = await Promise.all([api.get<Site>(base), api.get<Team>(`${base}/team`)]);
    setSite(s);
    setTeam(t);
  }, [base]);
  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setLive(await api.get<Live>(`${base}/live`));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) window.location.reload();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  }, [base]);

  useEffect(() => {
    void reloadSite().catch((e) => setError(String(e)));
    void refresh();
    const t = setInterval(() => document.visibilityState === "visible" && void refresh(), 5000);
    return () => clearInterval(t);
  }, [reloadSite, refresh]);

  if (!site) return <div className="boot">{error ?? "Loading site…"}</div>;
  const names = new Map<string, string>((team?.members ?? []).map((m) => [m.address, m.name ?? m.ens ?? `${m.address.slice(0, 6)}…${m.address.slice(-4)}`]));
  const roles = site.myRoles;
  return (
    <AppCtx.Provider
      value={{
        me: props.me,
        setMe: props.setMe,
        site,
        siteId: props.siteId,
        meta: props.meta,
        status: props.status,
        live,
        team,
        names,
        roles,
        can: (r) => canAct(roles, r),
        refresh,
        reloadSite,
        path: (p) => `${base}${p}`,
      }}
    >
      {props.children}
    </AppCtx.Provider>
  );
}

export type { TypedSignature };
