import { useEffect, useState } from "react";
import { api } from "../api";
import { shortAddr } from "../lib/format";
import type { Me } from "../types";
import { Action, Field } from "../ui/kit";
import { ApplyForm, MyApplications } from "./Onboarding";
import { Select } from "../ui/Select";

const zonesAll = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["UTC", "Asia/Kolkata", "Europe/Berlin", "America/New_York"];
  }
})();

export function Setup({ me, onCreated, onSignOut }: { me: Me; onCreated: (id: string) => void; onSignOut: () => void }) {
  const [joining, setJoining] = useState(() => window.location.hash.startsWith("#/join"));
  useEffect(() => {
    const f = () => setJoining(window.location.hash.startsWith("#/join"));
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  const [name, setName] = useState("");
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [line, setLine] = useState("Line 1");
  const [zones, setZones] = useState<string[]>(["Machining", "Assembly", "Quality & packing"]);
  const [zoneInput, setZoneInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const addr = me.user!.address;

  if (!me.canCreateSite || joining) return <JoinSite me={me} onSignOut={onSignOut} canCreate={me.canCreateSite} />;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ id: string }>("/v1/sites", { name: name.trim(), timezone: tz, lineName: line.trim(), zones });
      onCreated(r.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const addZone = () => {
    const z = zoneInput.trim();
    if (z && !zones.includes(z)) setZones([...zones, z]);
    setZoneInput("");
  };
  return (
    <div className="auth">
      <div className="auth-card wide">
        <div className="eyebrow">Set up · signed in as {shortAddr(addr)}</div>
        <h1>Create your site</h1>
        <p className="muted">A site is one plant. You become its administrator and plant manager, and invite your team by wallet address afterwards. Nothing is pre-filled with sample data: you connect real machines or datasets next.</p>
        <div className="form-grid">
          <Field label="Site name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pune Plant 1" autoFocus />
          </Field>
          <Field label="Time zone">
            <Select value={tz} onChange={setTz} options={zonesAll.map((z) => ({ value: z, label: z.replaceAll("_", " "), group: z.split("/")[0] }))} searchable />
          </Field>
          <Field label="First production line" hint="Autonomy is set per line. New lines start at L2 · Recommend.">
            <input className="input" value={line} onChange={(e) => setLine(e.target.value)} />
          </Field>
          <Field label="Zones" hint="Assets are grouped by zone on the floor view.">
            <div className="chips">
              {zones.map((z) => (
                <span key={z} className="chip">
                  {z}
                  <button type="button" aria-label={`Remove ${z}`} onClick={() => setZones(zones.filter((x) => x !== z))}>
                    ×
                  </button>
                </span>
              ))}
              <input className="chip-input" value={zoneInput} placeholder="Add zone ↵" onChange={(e) => setZoneInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addZone())} onBlur={addZone} />
            </div>
          </Field>
        </div>
        {error && <p className="field-e">{error}</p>}
        <div className="btns">
          <button type="button" className="btn accent" disabled={busy || name.trim().length < 2 || !line.trim()} onClick={submit}>
            Create site
          </button>
          <a className="btn" href="#/join">
            Join an existing site instead
          </a>
          <button type="button" className="btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

/** A wallet with no site yet applies to join one with the code its administrator shared. */
function JoinSite({ me, onSignOut, canCreate }: { me: Me; onSignOut: () => void; canCreate: boolean }) {
  const [code, setCode] = useState(() => new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("site") ?? "");
  const [site, setSite] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const addr = me.user!.address;
  return (
    <div className="auth">
      <div className="auth-card wide">
        <div className="eyebrow">Join a site · signed in as {shortAddr(addr)}</div>
        <h1>Apply to join a site</h1>
        <p className="muted">
          Enter the site code your administrator shared (Settings → Site code), or <a href="#/open">find a running pipeline</a> and apply for a role on it. Your application goes to the site's administrators, who approve it with their wallet signature.
        </p>
        {!site ? (
          <>
            <Field label="Site code" error={error}>
              <input className="input mono" value={code} onChange={(e) => setCode(e.target.value.trim())} placeholder="site_…" autoFocus />
            </Field>
            <div className="btns">
              <Action
                className="btn accent"
                disabled={code.length < 6}
                onClick={async () => {
                  setError(null);
                  try {
                    setSite(await api.get<{ id: string; name: string }>(`/v1/onboarding/site/${encodeURIComponent(code)}`));
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                Find site
              </Action>
              {canCreate && (
                <a className="btn" href="#/">
                  Create a new site instead
                </a>
              )}
              <button type="button" className="btn" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Applying to <b>{site.name}</b>.{" "}
              <button type="button" className="link" onClick={() => setSite(null)}>
                Change
              </button>
            </p>
            <ApplyForm siteId={site.id} kind="member" onDone={() => (setSent((n) => n + 1), setSite(null))} />
          </>
        )}
        <MyApplications refreshKey={sent} />
        <p className="faint small">Once approved, reload this page. Your wallet address: <span className="mono">{addr}</span></p>
        <button type="button" className="btn sm" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}
