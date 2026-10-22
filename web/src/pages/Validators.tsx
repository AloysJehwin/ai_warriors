import { useCallback, useEffect, useState } from "react";
import { parseUnits } from "viem";
import { api } from "../api";
import { useApp } from "../lib/app";
import { ago, dateTime, shortAddr } from "../lib/format";
import { useSign } from "../lib/sign";
import { fromUnits, trustTx } from "../lib/wallet";
import type { PackageSummary, TypedSignature, ValidatorsView, VendorRow } from "../types";
import { Action, Empty, Field, Loading, Modal, useToast } from "../ui/kit";
import { Select } from "../ui/Select";
import { WorldIdButton } from "../ui/WorldId";
import { ApplyForm, MyApplications } from "./Onboarding";

function ChainBanner({ v, onChange }: { v: ValidatorsView; onChange: () => Promise<unknown> }) {
  const { status, can, path, site } = useApp();
  const sign = useSign();
  const c = v.chain;
  if (!c.configured)
    return (
      <div className="notice">
        <b>Stakes are off.</b> No OrdoTrust contract is configured for this deployment, so validators are approved in-app and hold no stake. Set the <span className="mono">TRUST_*</span> variables to enforce validator credentials and stakes on-chain.
      </div>
    );
  const info = c.info && "minStake" in c.info ? c.info : null;
  return (
    <div className={`notice ${c.registered ? "ok" : "warn"}`}>
      <b>OrdoTrust on {status.trust?.name}</b>{" "}
      <span className="mono small">
        {status.trust?.explorerUrl ? (
          <a href={`${status.trust.explorerUrl.replace(/\/$/, "")}/address/${status.trust.address}`} target="_blank" rel="noreferrer">
            {shortAddr(status.trust?.address ?? "")}
          </a>
        ) : (
          shortAddr(status.trust?.address ?? "")
        )}
      </span>
      {info && (
        <p className="small">
          A validator signs only while holding at least {fromUnits(info.minStake, info.decimals)} {info.symbol} at stake. Unstaking takes {Math.round(info.unstakeCooldownSeconds / 86400)} days, so a recall raised meanwhile can still slash.
        </p>
      )}
      {c.registered ? (
        <p className="small">
          Site registered{c.registeredAt ? ` ${ago(c.registeredAt)}` : ""}.{" "}
          {c.txUrl && (
            <a href={c.txUrl} target="_blank" rel="noreferrer">
              Registration transaction
            </a>
          )}
        </p>
      ) : (
        <div className="btns">
          <span className="small">This site is not registered on-chain yet: credentials wait until it is.</span>
          {can("admin") && (
            <Action
              className="btn accent sm"
              onClick={async () => {
                const r = await sign({
                  title: `Register ${site.name} in OrdoTrust`,
                  request: () => api.post<TypedSignature>(path("/chain/register/sign-request")),
                  submit: (proof) => api.post(path("/chain/register"), proof),
                });
                if (r) await onChange();
              }}
            >
              Register site on-chain
            </Action>
          )}
        </div>
      )}
    </div>
  );
}

export function Validators() {
  const { path, me, siteId, status, can, names } = useApp();
  const [v, setV] = useState<ValidatorsView | null>(null);
  const [apply, setApply] = useState(false);
  const [amount, setAmount] = useState("");
  const [propose, setPropose] = useState(false);
  const [removing, setRemoving] = useState<ValidatorsView["validators"][number] | null>(null);
  const [appsKey, setAppsKey] = useState(0);
  const toast = useToast();
  const sign = useSign();
  const load = useCallback(() => api.get<ValidatorsView>(path("/validators")).then(setV), [path]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!v) return <Loading />;
  const trust = status.trust;
  const info = v.chain.info && "minStake" in v.chain.info ? v.chain.info : null;
  // removed validators stay listed by the server so they can still take their stake back
  const seated = v.validators.filter((x) => x.status === "approved");
  const mine = v.validators.find((x) => x.address === me.user!.address);
  const unit = (x: string) => (info ? `${fromUnits(x, info.decimals)} ${info.symbol}` : x);
  const tx = async (fn: "stake" | "requestUnstake" | "withdraw") => {
    if (!trust) return;
    const hash = await trustTx(trust, me.user!.address, fn, siteId, amount);
    toast(`Transaction sent: ${hash.slice(0, 10)}…`, "ok");
    setAmount("");
    // once it is final, Ordo schedules (or deletes) the payout at the end of the cooldown on Hedera
    setTimeout(() => void api.post(path("/validators/me/payout-schedule")).catch(() => null).then(load), 6000);
  };
  return (
    <div>
      <ChainBanner v={v} onChange={load} />
      <section className="section">
        <div className="section-h spread">
          <h2>Validators</h2>
          {v.me.row?.status !== "approved" && (
            <button type="button" className="btn accent" onClick={() => setApply(true)}>
              Apply as validator
            </button>
          )}
        </div>
        {seated.length === 0 ? (
          <Empty title="No validators yet">Only an approved validator can sign “Reviewed by” and “Approved by” on a validation package or release a quality gate. People apply here; an administrator approves with a signature.</Empty>
        ) : (
          <div className="card scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Validator</th>
                  <th>Scope</th>
                  <th>Approved</th>
                  {info && <th className="r">Stake</th>}
                  <th>Status</th>
                  {can("admin") && <th />}
                </tr>
              </thead>
              <tbody>
                {seated.map((x) => {
                  const st = !info ? (x.status === "approved" ? ["Can sign", "ok"] : [x.status, "bad"]) : !x.onchain ? ["Chain unreachable", "warn"] : x.onchain.active ? ["Active", "ok"] : x.onchain.unlockAt ? [`Unstaking · ${x.onchain.unlockAt * 1000 > Date.now() ? `free ${dateTime(new Date(x.onchain.unlockAt * 1000).toISOString())}` : "withdrawable"}`, "warn"] : ["Not staked", "warn"];
                  return (
                    <tr key={x.userId}>
                      <td>
                        <b>{x.name ?? names.get(x.address) ?? shortAddr(x.address)}</b>
                        <div className="faint small mono">{x.address}</div>
                      </td>
                      <td>{x.scopeLabel}</td>
                      <td>{ago(x.approvedAt)}</td>
                      {info && <td className="r">{x.onchain ? unit(x.onchain.stake) : "—"}</td>}
                      <td>
                        <span className={`tag ${st[1]}`}>{st[0]}</span>
                      </td>
                      {can("admin") && (
                        <td className="r">
                          <button type="button" className="btn sm danger" onClick={() => setRemoving(x)}>
                            Remove
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {mine && (
        <section className="section card">
          <div className="card-h">
            <h2>Your validator status</h2>
            <span className={`tag ${v.me.ok ? "ok" : mine.status === "removed" ? "bad" : "warn"}`}>{v.me.ok ? "You can sign" : mine.status === "removed" ? "Removed by an administrator" : "You cannot sign yet"}</span>
          </div>
          <div className="card-b">
            {v.me.reason && <p className="muted">{v.me.reason}</p>}
            {status.worldId && mine.status === "approved" && (
              <WorldIdButton
                done={v.me.human}
                onProof={async (worldId) => {
                  await api.post(path("/validators/world-id"), { worldId });
                  toast("Verified with World ID", "ok");
                  await load();
                }}
              />
            )}
            {!trust && v.me.ok && <p className="muted">You can sign “Reviewed by” and “Approved by” and release quality gates. Stakes are off on this deployment, so your approval is the whole credential.</p>}
            {trust && info && mine.onchain && (
              <>
                <dl className="kv">
                  <dt>Your stake</dt>
                  <dd>{unit(mine.onchain.stake)}</dd>
                  <dt>Minimum</dt>
                  <dd>{unit(info.minStake)}</dd>
                  {mine.onchain.unlockAt > 0 && (
                    <>
                      <dt>Withdrawable from</dt>
                      <dd>{dateTime(new Date(mine.onchain.unlockAt * 1000).toISOString())}</dd>
                    </>
                  )}
                  {mine.onchain.payout?.status === "scheduled" && mine.onchain.payout.url && (
                    <>
                      <dt>Paid back by</dt>
                      <dd>
                        <a href={mine.onchain.payout.url} target="_blank" rel="noreferrer">
                          Hedera schedule {mine.onchain.payout.scheduleId}
                        </a>{" "}
                        <span className="faint small">· runs on its own at {dateTime(mine.onchain.payout.executeAt)}, no need to withdraw</span>
                      </dd>
                    </>
                  )}
                </dl>
                <div className="inline">
                  <input className="input" style={{ maxWidth: 160 }} type="number" min={0} step="any" placeholder={`Amount in ${info.symbol}`} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Stake amount" />
                  <Action className="btn accent" disabled={!(Number(amount) > 0) || !v.chain.registered} onClick={() => tx("stake")}>
                    Stake
                  </Action>
                  <Action className="btn" disabled={BigInt(mine.onchain.stake) === 0n || mine.onchain.unlockAt > 0} onClick={() => tx("requestUnstake")}>
                    Request unstake
                  </Action>
                  <Action className="btn" disabled={!(mine.onchain.unlockAt > 0 && mine.onchain.unlockAt * 1000 <= Date.now())} onClick={() => tx("withdraw")}>
                    Withdraw
                  </Action>
                </div>
                <p className="faint small">Stake and withdraw are transactions from your own wallet on {trust.name}; you pay their gas. Ordo never holds your stake.</p>
              </>
            )}
          </div>
        </section>
      )}

      {trust && (
        <section className="section">
          <div className="section-h spread">
            <h2>Slash proposals</h2>
            {can("plant_manager") && seated.length > 0 && (
              <button type="button" className="btn danger sm" onClick={() => setPropose(true)}>
                Propose a slash
              </button>
            )}
          </div>
          <p className="muted small">A validator's stake is slashed only when two other active validators and a plant manager sign the same proposal. The amount goes to the site's quality fund, not to the people who signed.</p>
          {v.proposals.length === 0 ? (
            <p className="faint">No proposals.</p>
          ) : (
            v.proposals.map((p) => (
              <div key={p.id} className="card app-card">
                <div className="card-h">
                  <div>
                    Slash <b>{names.get(p.validatorAddress) ?? shortAddr(p.validatorAddress)}</b> by <b>{unit(p.amount)}</b>
                    <div className="faint small">
                      proposed {ago(p.createdAt)} by {names.get(p.createdBy) ?? shortAddr(p.createdBy)}
                      {p.recallPackageId ? ` · recall of ${p.recallPackageId}` : ""}
                    </div>
                  </div>
                  <span className={`tag ${p.status === "executed" ? "bad" : "accent"}`}>{p.status}</span>
                </div>
                <div className="card-b">
                  <p>{p.reason}</p>
                  <p className="small muted">
                    Signatures: {p.signatures.filter((s) => s.capacity === "validator").length}/2 validators · {p.signatures.some((s) => s.capacity === "plant_manager") ? 1 : 0}/1 plant manager
                    {p.chain?.txUrl && (
                      <>
                        {" "}
                        ·{" "}
                        <a href={p.chain.txUrl} target="_blank" rel="noreferrer">
                          slash transaction
                        </a>
                      </>
                    )}
                    {p.chain?.error && <span className="bad-text"> · {p.chain.error}</span>}
                  </p>
                  {p.status === "open" && p.validatorAddress !== me.user!.address && !p.signatures.some((s) => s.address === me.user!.address) && (
                    <Action
                      className="btn danger sm"
                      onClick={async () => {
                        const r = await sign({
                          title: `Slash ${shortAddr(p.validatorAddress)} by ${unit(p.amount)}`,
                          request: () => api.post<TypedSignature>(path(`/slash/${p.id}/sign-request`)),
                          submit: (proof) => api.post(path(`/slash/${p.id}/sign`), proof),
                        });
                        if (r) await load();
                      }}
                    >
                      Sign this proposal
                    </Action>
                  )}
                </div>
              </div>
            ))
          )}
        </section>
      )}
      <MyApplications refreshKey={appsKey} />
      <Modal open={apply} onClose={() => setApply(false)} eyebrow="Validator onboarding" title="Apply as a validator" width={640}>
        <p className="muted">Validators sign the quality decisions that release product. An administrator reviews your qualifications and approves with a signature{trust ? `; then you stake ${info ? unit(info.minStake) : "the minimum"} from your wallet to become active` : ""}.</p>
        <ApplyForm siteId={siteId} kind="validator" onCancel={() => setApply(false)} onDone={() => (setApply(false), setAppsKey((k) => k + 1))} />
      </Modal>
      {removing && (
        <RemoveValidator
          who={removing}
          staked={Boolean(info && removing.onchain && BigInt(removing.onchain.stake) > 0n)}
          onClose={() => setRemoving(null)}
          onRemove={async (comment) => {
            const x = removing;
            setRemoving(null);
            const r = await sign<{ removed: true; chain: { status: string; error: string | null } | null }>({
              title: `Remove ${x.name ?? names.get(x.address) ?? shortAddr(x.address)} as validator`,
              request: (chainId) => api.post<TypedSignature>(path(`/validators/${x.userId}/remove/sign-request`), { comment, chainId }),
              submit: (proof) => api.post(path(`/validators/${x.userId}/remove`), { comment, ...proof }),
            });
            if (!r) return;
            toast(r.chain?.status === "failed" ? `Removed in Ordo; the on-chain revoke failed: ${r.chain.error ?? "retry from Settings"}` : "Validator removed", r.chain?.status === "failed" ? "bad" : "ok");
            await load();
          }}
        />
      )}
      {propose && info && <ProposeSlash v={v} decimals={info.decimals} symbol={info.symbol} onClose={() => setPropose(false)} onDone={load} />}
    </div>
  );
}

/** An administrator takes a validator's seat away, with a signature OrdoTrust checks before it revokes the credential. */
function RemoveValidator({ who, staked, onClose, onRemove }: { who: ValidatorsView["validators"][number]; staked: boolean; onClose: () => void; onRemove: (comment: string) => Promise<void> }) {
  const { names, status } = useApp();
  const [reason, setReason] = useState("");
  const name = who.name ?? names.get(who.address) ?? shortAddr(who.address);
  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Validators"
      title={`Remove ${name}`}
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action className="btn danger" onClick={() => onRemove(reason.trim())}>
            Sign and remove
          </Action>
        </div>
      }
    >
      <p className="muted">
        {name} stops signing “Reviewed by”, “Approved by” and quality gates as {who.scopeLabel.toLowerCase()} validator straight away. What they already signed stays on the record.
      </p>
      <ul className="gate-why">
        {status.trust && <li>Their VALIDATOR credential is revoked in OrdoTrust with your signature.</li>}
        {staked && <li>Their stake stays theirs: they can request unstake and withdraw it from this page after the cooldown.</li>}
        {status.worldId && <li>Their World ID is released at this site, so the same person can apply again later, from any wallet.</li>}
        <li>They stay on the team as {who.scopeLabel.toLowerCase()}; take that role away in Team if they are leaving the site.</li>
      </ul>
      <Field label="Reason" hint="Optional. Goes into the signed record.">
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </Field>
    </Modal>
  );
}

function ProposeSlash({ v, decimals, symbol, onClose, onDone }: { v: ValidatorsView; decimals: number; symbol: string; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { path, names } = useApp();
  const [who, setWho] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [recall, setRecall] = useState<string | null>(null);
  const [pkgs, setPkgs] = useState<PackageSummary[]>([]);
  useEffect(() => {
    void api.get<PackageSummary[]>(path("/validation")).then((l) => setPkgs(l.filter((p) => p.status === "released")));
  }, [path]);
  const target = v.validators.find((x) => x.userId === who);
  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Recall"
      title="Propose a slash"
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action
            className="btn danger"
            disabled={!who || !(Number(amount) > 0) || reason.trim().length < 10}
            onClick={async () => {
              await api.post(path("/slash"), { validatorUserId: who, amount: parseUnits(amount, decimals).toString(), reason: reason.trim(), recallPackageId: recall });
              onClose();
              await onDone();
            }}
          >
            Open proposal
          </Action>
        </div>
      }
    >
      <Field label="Validator">
        <Select value={who} onChange={setWho} options={v.validators.filter((x) => x.status === "approved").map((x) => ({ value: x.userId, label: x.name ?? names.get(x.address) ?? shortAddr(x.address), hint: x.onchain ? `${fromUnits(x.onchain.stake, decimals)} ${symbol} staked` : x.scopeLabel }))} placeholder="Choose validator" />
      </Field>
      <div className="form-grid two">
        <Field label={`Amount (${symbol})`} hint={target?.onchain ? `At most ${fromUnits(target.onchain.stake, decimals)} ${symbol}` : undefined}>
          <input className="input" type="number" min={0} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Released package being recalled" hint="Optional">
          <Select value={recall} onChange={setRecall} options={pkgs.map((p) => ({ value: p.id, label: `${p.code} · ${p.title}` }))} placeholder="None" />
        </Field>
      </div>
      <Field label="Reason" hint="What was released that should not have been, and the evidence. Signers read this.">
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      </Field>
    </Modal>
  );
}

export function Vendors() {
  const { path, siteId } = useApp();
  const [rows, setRows] = useState<VendorRow[] | null>(null);
  const [apply, setApply] = useState(false);
  const [key, setKey] = useState(0);
  useEffect(() => {
    void api.get<VendorRow[]>(path("/vendors")).then(setRows);
  }, [path, key]);
  if (!rows) return <Loading />;
  return (
    <div>
      <div className="section-h spread">
        <p className="muted lede">Maintenance vendors that agents may pay for work orders. Each one is approved by an administrator with a signature; with OrdoTrust they hold an on-chain vendor credential.</p>
        <button type="button" className="btn accent" onClick={() => setApply(true)}>
          Register as vendor
        </button>
      </div>
      {rows.length === 0 ? (
        <Empty title="No vendors yet">A vendor registers with company details, services, rate and response commitment; an administrator approves it.</Empty>
      ) : (
        <div className="card scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>Company</th>
                <th>Services</th>
                <th>Rate</th>
                <th>Response</th>
                <th>Wallet</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td>
                    <b>{v.company}</b>
                  </td>
                  <td>{v.categories || "—"}</td>
                  <td>{v.hourlyRate ?? "—"}</td>
                  <td>{v.responseMinutes ? `${v.responseMinutes} min` : "—"}</td>
                  <td className="mono small">{v.address}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <MyApplications refreshKey={key} />
      <Modal open={apply} onClose={() => setApply(false)} eyebrow="Vendor onboarding" title="Register as a maintenance vendor" width={640}>
        <ApplyForm siteId={siteId} kind="vendor" onCancel={() => setApply(false)} onDone={() => (setApply(false), setKey((k) => k + 1))} />
      </Modal>
    </div>
  );
}
