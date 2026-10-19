import { useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { ago, shortAddr } from "../lib/format";
import type { Role } from "../types";
import { Action, Field, Modal, useToast } from "../ui/kit";
import { Select } from "../ui/Select";

export function TeamPage() {
  const { team, meta, can, path, reloadSite, me } = useApp();
  const [invite, setInvite] = useState(false);
  const [addr, setAddr] = useState("");
  const [role, setRole] = useState<Role>("operator");
  const toast = useToast();
  const admin = can("admin");
  const label = (r: Role) => meta.roles.find((x) => x.key === r)?.label ?? r;
  const valid = /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
  return (
    <div>
      <div className="page-head">
        <div className="ph-text">
          <div className="eyebrow">{team?.members.length ?? 0} members</div>
          <h1>Team</h1>
          <p className="muted lede">People are identified by wallet address. A role decides which gates and signatures they may give; higher roles can also act for lower ones.</p>
        </div>
        {admin && (
          <div className="ph-actions">
            <button type="button" className="btn accent" onClick={() => setInvite(true)}>
              Add by wallet address
            </button>
          </div>
        )}
      </div>
      <div className="card scroll-x">
        <table className="t">
          <thead>
            <tr>
              <th>Person</th>
              <th>Wallet</th>
              <th>Roles</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {team?.members.map((m) => (
              <tr key={m.userId}>
                <td>
                  <b>{m.name ?? m.ens ?? "—"}</b>
                  {m.address === me.user!.address && <span className="tag accent">you</span>}
                  {m.ens && m.name && <div className="faint small">{m.ens}</div>}
                </td>
                <td className="mono small">{m.address}</td>
                <td>
                  <div className="chips">
                    {m.roles.map((r) => (
                      <span key={r} className="chip">
                        {label(r)}
                        {admin && (
                          <button
                            type="button"
                            aria-label={`Remove ${label(r)}`}
                            onClick={async () => {
                              try {
                                await api.del(path(`/team/members/${m.userId}/roles/${r}`));
                                await reloadSite();
                              } catch (e) {
                                toast(e instanceof Error ? e.message : String(e), "bad");
                              }
                            }}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="faint">{ago(m.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {team && team.invites.length > 0 && (
        <section className="section">
          <div className="section-h">
            <h2>Pending invites</h2>
            <span className="muted small">The role applies the first time this wallet signs in</span>
          </div>
          <div className="card">
            <table className="t">
              <tbody>
                {team.invites.map((i) => (
                  <tr key={i.id}>
                    <td className="mono small">{i.address}</td>
                    <td>{label(i.role)}</td>
                    <td className="faint">{ago(i.createdAt)}</td>
                    <td className="r">
                      {admin && (
                        <Action className="btn sm" onClick={async () => (await api.del(path(`/team/invites/${i.id}`)), await reloadSite())}>
                          Cancel
                        </Action>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <Modal
        open={invite}
        onClose={() => setInvite(false)}
        title="Add a person"
        footer={
          <div className="btns end">
            <button type="button" className="btn" onClick={() => setInvite(false)}>
              Cancel
            </button>
            <Action
              className="btn accent"
              disabled={!valid}
              onClick={async () => {
                const r = await api.post<{ added: boolean }>(path("/team/invites"), { address: addr.trim(), role });
                toast(r.added ? `Added ${shortAddr(addr.trim())} as ${label(role)}` : `Invited ${shortAddr(addr.trim())}: the role applies at first sign-in`, "ok");
                setAddr("");
                setInvite(false);
                await reloadSite();
              }}
            >
              Add
            </Action>
          </div>
        }
      >
        <Field label="Wallet address" error={addr && !valid ? "Enter a 0x address with 40 hex characters" : null}>
          <input className="input mono" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x…" autoFocus />
        </Field>
        <Field label="Role">
          <Select<Role> value={role} onChange={setRole} options={meta.roles.map((r) => ({ value: r.key, label: r.label }))} />
        </Field>
        <p className="faint small">To give one person several roles, add the address again with another role.</p>
      </Modal>
    </div>
  );
}
