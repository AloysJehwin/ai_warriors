import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import { useSign } from "../lib/sign";
import { ago, shortAddr } from "../lib/format";
import type { OnboardingKind, OnboardingView, TypedSignature } from "../types";
import { Action, Field, Segmented, useToast } from "../ui/kit";
import { Select } from "../ui/Select";

const MEMBER_ROLES = [
  { value: "operator", label: "Operator", hint: "Executes manual stages, records units, raises holds" },
  { value: "supervisor", label: "Supervisor", hint: "Starts runs, releases supervisor gates" },
  { value: "process_engineer", label: "Process engineer", hint: "Builds pipelines, prepares validation packages" },
  { value: "quality_engineer", label: "Quality engineer", hint: "Reviews checks; signing needs validator approval" },
  { value: "maintenance_lead", label: "Maintenance lead", hint: "Approves work orders" },
  { value: "plant_manager", label: "Plant manager", hint: "Final approval, autonomy, escalations" },
];
export const SCOPES = [
  { value: "quality", label: "Quality", hint: "Signs as Reviewed by and releases quality gates" },
  { value: "process", label: "Process", hint: "Reviews process changes and pilots" },
  { value: "plant", label: "Plant", hint: "Signs as Approved by (plant manager)" },
];
const statusTag = (s: string) => (s === "approved" ? "ok" : s === "rejected" ? "bad" : "accent");

/** One form for joining a site, applying as a validator, or registering as a vendor. */
export function ApplyForm({
  siteId,
  kind,
  initialRole,
  context,
  onDone,
  onCancel,
}: {
  siteId: string;
  kind: OnboardingKind;
  initialRole?: string;
  /** extra fields the administrator sees with the application, e.g. the pipeline it came from */
  context?: Record<string, string>;
  onDone: (r: OnboardingView) => void;
  onCancel?: () => void;
}) {
  const [role, setRole] = useState<string>(initialRole ?? (kind === "validator" ? "quality" : kind === "vendor" ? "vendor" : "operator"));
  const [form, setForm] = useState<Record<string, string>>({ ...context, fullName: "" });
  const [files, setFiles] = useState<File[]>([]);
  const toast = useToast();
  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const valid = form.fullName?.trim() && (kind !== "validator" || form.qualifications?.trim()) && (kind !== "vendor" || form.company?.trim());
  return (
    <div className="apply">
      <div className="form-grid two">
        <Field label="Full name">
          <input className="input" value={form.fullName ?? ""} onChange={set("fullName")} autoFocus />
        </Field>
        <Field label={kind === "vendor" ? "Contact phone or email" : "Employee or badge id"} hint="Optional">
          <input className="input" value={form.reference ?? ""} onChange={set("reference")} />
        </Field>
      </div>
      {kind === "member" && (
        <Field label="Role you are asking for">
          <Select value={role} onChange={setRole} options={MEMBER_ROLES} />
        </Field>
      )}
      {kind === "validator" && (
        <>
          <Field label="Validator scope" hint={SCOPES.find((s) => s.value === role)?.hint}>
            <Segmented value={role} onChange={setRole} options={SCOPES.map((s) => ({ value: s.value, label: s.label }))} />
          </Field>
          <Field label="Qualifications" hint="Certifications, audits led, years in quality or process roles. The admin sees this with your files.">
            <textarea value={form.qualifications ?? ""} onChange={set("qualifications")} maxLength={2000} />
          </Field>
        </>
      )}
      {kind === "vendor" && (
        <>
          <div className="form-grid two">
            <Field label="Company">
              <input className="input" value={form.company ?? ""} onChange={set("company")} />
            </Field>
            <Field label="Services" hint="Comma-separated; include machine kinds you service, e.g. cnc, press, robot">
              <input className="input" value={form.categories ?? ""} onChange={set("categories")} />
            </Field>
            <Field label="Hourly rate (HBAR)" hint="The maintenance agent escrows rate × hours for each work order">
              <input className="input" value={form.hourlyRate ?? ""} onChange={set("hourlyRate")} inputMode="decimal" />
            </Field>
            <Field label="Response commitment">
              <Select value={form.responseMinutes ?? null} onChange={(v) => setForm({ ...form, responseMinutes: v })} options={["30", "60", "120", "240", "480"].map((m) => ({ value: m, label: `Within ${Number(m) >= 60 ? `${Number(m) / 60} h` : `${m} min`}` }))} placeholder="Choose" />
            </Field>
          </div>
        </>
      )}
      <Field label={kind === "vendor" ? "Insurance and certification files" : "Certificates and training records"} hint="Optional · up to 4 MB each · hashed on upload">
        <label className="drop">
          <input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
          {files.length ? files.map((f) => f.name).join(", ") : "Choose files"}
        </label>
      </Field>
      <div className="btns end">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <Action
          className="btn accent"
          disabled={!valid}
          onClick={async () => {
            let r = await api.post<OnboardingView>("/v1/onboarding", { siteId, kind, role, form });
            for (const f of files) {
              const fd = new FormData();
              fd.set("file", f);
              r = await api.upload<OnboardingView>(`/v1/onboarding/${siteId}/requests/${r.id}/files`, fd);
            }
            toast("Application sent to the site administrator", "ok");
            onDone(r);
          }}
        >
          Send application
        </Action>
      </div>
    </div>
  );
}

export function MyApplications({ refreshKey = 0 }: { refreshKey?: number }) {
  const [rows, setRows] = useState<OnboardingView[] | null>(null);
  useEffect(() => {
    void api.get<OnboardingView[]>("/v1/onboarding/mine").then(setRows);
  }, [refreshKey]);
  if (!rows?.length) return null;
  return (
    <div className="my-apps">
      <span className="label">Your applications</span>
      {rows.map((r) => (
        <div key={r.id} className="row-between">
          <span>
            <b>{r.roleLabel}</b> <span className="muted">at {r.siteName ?? r.siteId}</span>
            <div className="faint small">
              sent {ago(r.createdAt)}
              {r.reason ? ` · “${r.reason}”` : ""}
            </div>
          </span>
          <span className={`tag ${statusTag(r.status)}`}>{r.status}</span>
        </div>
      ))}
    </div>
  );
}

/** The admin's queue: each approval is a signature that becomes the role (and, with OrdoTrust, an on-chain credential). */
export function ReviewQueue({ path, onChange }: { path: (p: string) => string; onChange: () => void }) {
  const [rows, setRows] = useState<OnboardingView[] | null>(null);
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const sign = useSign();
  const load = () => api.get<OnboardingView[]>(path(`/onboarding?status=${filter}`)).then(setRows);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);
  const decide = async (r: OnboardingView, decision: "approve" | "reject") => {
    const done = await sign<OnboardingView>({
      title: `${decision === "approve" ? "Approve" : "Decline"} ${r.form.fullName ?? shortAddr(r.address)} as ${r.roleLabel}`,
      request: (chainId) => api.post<TypedSignature>(path(`/onboarding/${r.id}/sign-request`), { decision, chainId }),
      submit: (proof) => api.post<OnboardingView>(path(`/onboarding/${r.id}/decide`), { decision, comment: "", ...proof }),
    });
    if (done) {
      await load();
      onChange();
    }
  };
  if (!rows) return null;
  return (
    <div>
      <div className="filters">
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "pending", label: "Waiting" },
            { value: "all", label: "All" },
          ]}
        />
      </div>
      {rows.length === 0 && <p className="muted">No applications {filter === "pending" ? "waiting" : "yet"}. Share the site code from Settings so people can apply.</p>}
      <div className="apps">
        {rows.map((r) => (
          <article key={r.id} className="card app-card">
            <div className="card-h">
              <div>
                <b>{r.form.fullName ?? "—"}</b> <span className="muted">applies as</span> <b>{r.roleLabel}</b>
                <div className="faint small mono">{r.address}</div>
              </div>
              <span className={`tag ${statusTag(r.status)}`}>{r.status}</span>
            </div>
            <div className="card-b">
              <dl className="kv">
                {Object.entries(r.form)
                  .filter(([k, v]) => k !== "fullName" && v)
                  .map(([k, v]) => (
                    <Fragment key={k}>
                      <dt>{k.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
                      <dd>{v}</dd>
                    </Fragment>
                  ))}
                <dt>sent</dt>
                <dd>{ago(r.createdAt)}</dd>
              </dl>
              {r.files.length > 0 && (
                <div className="chips">
                  {r.files.map((f) => (
                    <a key={f.sha256} className="chip" href={api.url(path(`/onboarding/${r.id}/files/${f.sha256}`))} title={f.sha256}>
                      {f.name}
                    </a>
                  ))}
                </div>
              )}
              {r.chain && (
                <p className="small">
                  On-chain credential: <span className={r.chain.status === "done" ? "ok-text" : r.chain.status === "failed" ? "bad-text" : "muted"}>{r.chain.status.replace("_", " ")}</span>
                  {r.chain.txUrl && (
                    <>
                      {" "}
                      ·{" "}
                      <a href={r.chain.txUrl} target="_blank" rel="noreferrer">
                        transaction
                      </a>
                    </>
                  )}
                  {r.chain.error && <span className="bad-text"> · {r.chain.error}</span>}
                  {(r.chain.status === "failed" || r.chain.status === "waiting_site") && (
                    <Action className="btn sm" onClick={async () => (await api.post(path("/chain/retry"), { ref: r.id }), await load())}>
                      Retry
                    </Action>
                  )}
                </p>
              )}
              {r.status === "pending" && (
                <div className="btns">
                  <Action className="btn accent" onClick={() => decide(r, "approve")}>
                    Approve and sign
                  </Action>
                  <Action className="btn" onClick={() => decide(r, "reject")}>
                    Decline
                  </Action>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
