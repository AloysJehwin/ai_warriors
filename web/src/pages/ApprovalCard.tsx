import { useState } from "react";
import { api, canApprove, ROLE_LABEL, type Actor } from "../api";
import { describeAction } from "../describe";
import { pushAlert } from "../live";
import type { Approval } from "../types";

export function ApprovalCard({ a, actor }: { a: Approval; actor: Actor }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (kind: "approve" | "reject") => {
    setBusy(true);
    try {
      if (kind === "approve") await api.approve(a.id, actor, reason || undefined);
      else await api.reject(a.id, actor, reason);
      setReason("");
    } catch (e) {
      pushAlert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const pending = a.status === "pending";
  const allowed = canApprove(actor.role, a.requiredRole);
  return (
    <div className="card" data-testid={`approval-${a.id}`}>
      <div className="card-h">
        <div>
          <div className="eyebrow">
            {a.incidentId} · needs {ROLE_LABEL[a.requiredRole]}
          </div>
          <h3 style={{ marginTop: 4 }}>{describeAction(a.action)}</h3>
        </div>
        <span className={`pill ${pending ? "warn" : a.status === "approved" ? "ok" : "bad"}`}>{a.status}</span>
      </div>
      <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="muted">{a.policy.explanation}</div>
        <div className="btns faint" style={{ fontSize: 12 }}>
          {a.policy.ruleIds.map((r) => (
            <span key={r} className="pill">
              {r}
            </span>
          ))}
          <span className="mono">policy v{a.policy.policyVersion}</span>
          {a.externalRef && <span className="mono">on-chain: {a.externalRef}</span>}
        </div>
        {pending && !allowed ? (
          <div className="muted">
            You are acting as {ROLE_LABEL[actor.role]}. Switch to <b>{ROLE_LABEL[a.requiredRole]}</b> in the sidebar to decide.
          </div>
        ) : pending ? (
          <>
            <textarea placeholder="Reason (required to reject)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
            <div className="btns">
              <button className="btn primary" disabled={busy} onClick={() => act("approve")}>
                Approve as {ROLE_LABEL[actor.role]}
              </button>
              <button className="btn danger" disabled={busy || reason.trim().length < 3} onClick={() => act("reject")}>
                Reject
              </button>
            </div>
          </>
        ) : (
          <div className="muted">
            {a.status} by {a.actor ?? "system"}
            {a.reason ? ` — “${a.reason}”` : ""}
          </div>
        )}
      </div>
    </div>
  );
}
