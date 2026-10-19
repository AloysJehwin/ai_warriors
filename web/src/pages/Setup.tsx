import { useState } from "react";
import { api } from "../api";
import { shortAddr } from "../lib/format";
import type { Me } from "../types";
import { Field } from "../ui/kit";
import { Select } from "../ui/Select";

const zonesAll = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["UTC", "Asia/Kolkata", "Europe/Berlin", "America/New_York"];
  }
})();

export function Setup({ me, onCreated, onSignOut }: { me: Me; onCreated: (id: string) => void; onSignOut: () => void }) {
  const [name, setName] = useState("");
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [line, setLine] = useState("Line 1");
  const [zones, setZones] = useState<string[]>(["Machining", "Assembly", "Quality & packing"]);
  const [zoneInput, setZoneInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const addr = me.user!.address;

  if (!me.canCreateSite)
    return (
      <div className="auth">
        <div className="auth-card">
          <div className="brand big">
            <b>Ordo</b>
          </div>
          <h1>Waiting for an invite</h1>
          <p className="muted">You are signed in as</p>
          <p className="mono copy">{addr}</p>
          <p className="muted">Send this address to your site administrator. Once they add it with a role, reload this page.</p>
          <div className="btns">
            <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(addr)}>
              Copy address
            </button>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button type="button" className="btn" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    );

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
          <button type="button" className="btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
