import { ROLE_LABEL, type Actor } from "../api";
import type { LiveState } from "../live";
import { ApprovalCard } from "./ApprovalCard";

export function ApprovalsPage({ live, actor }: { live: LiveState; actor: Actor }) {
  const all = Object.values(live.approvals).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pending = all.filter((a) => a.status === "pending");
  const done = all.filter((a) => a.status !== "pending").slice(0, 10);
  return (
    <>
      <div className="header">
        <div>
          <div className="eyebrow">Approvals & exceptions</div>
          <h1>Waiting for a person</h1>
          <div className="muted">
            Actions the policy guard escalated. You are acting as <b>{ROLE_LABEL[actor.role]}</b>; switch role in the sidebar.
          </div>
        </div>
      </div>
      <div className="grid3">
        {pending.length === 0 && <div className="card empty">Nothing pending.</div>}
        {pending.map((a) => (
          <ApprovalCard key={a.id} a={a} actor={actor} />
        ))}
      </div>
      {done.length > 0 && (
        <div className="section">
          <div className="section-h">
            <h2>Recently decided</h2>
          </div>
          <div className="grid3">
            {done.map((a) => (
              <ApprovalCard key={a.id} a={a} actor={actor} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
