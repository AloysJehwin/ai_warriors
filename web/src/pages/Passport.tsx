import { useEffect, useState } from "react";
import { api } from "../api";
import { dateTime, shortAddr } from "../lib/format";
import { fromUnits } from "../lib/wallet";
import type { PassportStatus, PublicPassport, SpecProof } from "../types";
import { QR } from "../ui/QR";

const STATUS: Record<PassportStatus, [string, string]> = {
  in_production: ["In production", "warn"],
  held: ["On hold", "bad"],
  completed: ["Completed", "ok"],
  aborted: ["Stopped", "bad"],
  shipped: ["Shipped", "ok"],
};
const MEANING: Record<string, string> = { performed: "Performed by", reviewed: "Reviewed by", approved: "Approved by" };

const Check = ({ ok, children }: { ok: boolean | null; children: React.ReactNode }) => (
  <li className={`pp-check ${ok === null ? "" : ok ? "ok" : "bad"}`}>
    <span aria-hidden>{ok === null ? "·" : ok ? "✓" : "✕"}</span>
    <span>{children}</span>
  </li>
);

type BrowserCheck = { state: "idle" } | { state: "checking" } | { state: "done"; ok: number; of: number } | { state: "error"; message: string };

/**
 * Re-check every proof here, with snarkjs and the published verification key, so a buyer need not trust Ordo's
 * server: each proof must verify, and its public signals must be the subject, target and commitment shown.
 */
async function verifyInBrowser(proofs: SpecProof[]): Promise<{ ok: number; of: number }> {
  const [{ groth16 }, key] = await Promise.all([import("snarkjs"), api.get<{ verificationKey: unknown }>("/v1/public/zk/spec-check")]);
  let ok = 0;
  for (const z of proofs) if (z.publicSignals && (await groth16.verify(key.verificationKey, z.publicSignals, z.proof as never).catch(() => false))) ok++;
  return { ok, of: proofs.length };
}

/** The lot's public passport: what anyone scanning the QR code on a shipped lot sees, without signing in. */
export function Passport({ runId }: { runId: string }) {
  const [p, setP] = useState<PublicPassport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browser, setBrowser] = useState<BrowserCheck>({ state: "idle" });
  useEffect(() => {
    api
      .get<PublicPassport>(`/v1/public/passports/${encodeURIComponent(runId)}`)
      .then(setP)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [runId]);

  if (error)
    return (
      <div className="pp">
        <div className="pp-brand">Ordo · Lot passport</div>
        <p className="field-e">{error}</p>
      </div>
    );
  if (!p) return <div className="boot">Loading passport…</div>;
  const x = p.passport;
  const [label, tone] = STATUS[x.status];
  const proof = x.proof;
  const criteria = x.stages.flatMap((s) => s.criteria);
  const met = criteria.filter((c) => c.ok === true);
  const proven = met.flatMap((c) => (c.zk?.status === "proven" ? [c.zk] : []));
  const runBrowserCheck = () => {
    setBrowser({ state: "checking" });
    verifyInBrowser(proven)
      .then((r) => setBrowser({ state: "done", ...r }))
      .catch((e) => setBrowser({ state: "error", message: e instanceof Error ? e.message : String(e) }));
  };
  const pageUrl = x.pageUrl.startsWith("http") ? x.pageUrl : `${window.location.origin}${x.pageUrl}`;
  return (
    <div className="pp">
      <header className="pp-head">
        <div>
          <div className="pp-brand">Ordo · Lot passport</div>
          <h1>{p.name}</h1>
          <p className="muted">
            {x.quantity} units of <b>{x.product.name}</b> v{x.product.version} · {x.product.category}
            {x.site ? ` · made at ${x.site}` : ""}
          </p>
          <p className="small muted">
            Started {dateTime(x.startedAt)}
            {x.finishedAt ? ` · finished ${dateTime(x.finishedAt)}` : ""}
          </p>
          <span className={`tag ${tone}`}>{label}</span>
        </div>
        <div className="pp-qr">
          <QR value={pageUrl} label={`QR code for ${p.name}`} />
          <span className="faint small mono">{runId}</span>
        </div>
      </header>

      <section className="pp-card">
        <h2>Verification</h2>
        <ul className="pp-checks">
          <Check ok={proof.chainIntact}>
            Ordo's ledger re-walked from the first entry to #{proof.headSeq}: {proof.chainIntact ? "every hash links" : "the chain is broken"} · this lot has {proof.entries} entries
          </Check>
          {proof.anchor ? (
            <Check ok={proof.anchor.matchesChain && proof.anchor.external.ok}>
              Anchored at #{proof.anchor.toSeq} ({proof.anchor.kind === "hedera-hcs" ? "Hedera Consensus Service" : "signed checkpoint"}):{" "}
              {proof.anchor.url ? (
                <a href={proof.anchor.url} target="_blank" rel="noreferrer">
                  {proof.anchor.ref}
                </a>
              ) : (
                <span className="mono">{proof.anchor.ref}</span>
              )}{" "}
              · {proof.anchor.external.detail}
            </Check>
          ) : (
            <Check ok={null}>Not anchored yet: the ledger is anchored every few minutes</Check>
          )}
          {met.length > 0 && (
            <Check ok={proven.length === met.length && proven.every((z) => z.verified) ? true : proven.some((z) => z.verified === false) ? false : null}>
              {proven.length} of {met.length} criteria met are proven in zero knowledge: each proof shows the measurement meets its target without revealing it, against a
              commitment recorded in the ledger when the stage closed.{" "}
              {proven.length > 0 &&
                (browser.state === "idle" ? (
                  <button type="button" className="link" onClick={runBrowserCheck}>
                    Verify in this browser
                  </button>
                ) : browser.state === "checking" ? (
                  <span className="muted">Verifying…</span>
                ) : browser.state === "done" ? (
                  <b>
                    {browser.ok} of {browser.of} verified in this browser
                  </b>
                ) : (
                  <span className="field-e">{browser.message}</span>
                ))}
            </Check>
          )}
          {x.nft ? (
            <Check ok={x.nft.serial !== null && !x.nft.error}>
              Passport NFT{" "}
              {x.nft.url ? (
                <a href={x.nft.url} target="_blank" rel="noreferrer">
                  {x.nft.tokenId} #{x.nft.serial}
                </a>
              ) : (
                <span className="mono">{x.nft.tokenId}</span>
              )}
              {x.nft.serial === null ? " · minting" : ` · on-chain status ${x.nft.onchainStatus?.replace("_", " ")}`}
            </Check>
          ) : (
            <Check ok={null}>No NFT: this deployment keeps passports in Ordo only</Check>
          )}
          {x.ens && (
            <Check ok={x.ens.releases.every((r) => r.status === "done") ? true : x.ens.releases.some((r) => r.status === "failed") ? false : null}>
              ENS name{" "}
              <a href={x.ens.url} target="_blank" rel="noreferrer" className="mono">
                {x.ens.name}
              </a>
              {x.ens.releases.length === 0
                ? " · resolves to this passport"
                : x.ens.releases.map((r) => (
                    <span key={r.packageId}>
                      {" · "}
                      {r.txUrl ? (
                        <a href={r.txUrl} target="_blank" rel="noreferrer">
                          release recorded against the signers' ENS credentials
                        </a>
                      ) : r.status === "failed" ? (
                        `release not recorded: ${r.error}`
                      ) : (
                        "recording the release on ENS"
                      )}
                    </span>
                  ))}
            </Check>
          )}
          {x.shipment && (
            <Check ok>
              Shipped {dateTime(x.shipment.at)} to <span className="mono">{x.shipment.to}</span>
              {x.shipment.txUrl && (
                <>
                  {" "}
                  ·{" "}
                  <a href={x.shipment.txUrl} target="_blank" rel="noreferrer">
                    {x.shipment.pending ? "NFT airdrop, awaiting the customer's claim" : "NFT delivered"}
                  </a>
                </>
              )}
            </Check>
          )}
        </ul>
        <p className="faint small">Checked {dateTime(proof.checkedAt)}.</p>
      </section>

      {x.releases.length > 0 && (
        <section className="pp-card">
          <h2>Released by validation</h2>
          {x.releases.map((r) => (
            <div key={r.id} className="pp-release">
              <b>
                VP-{r.number} · {r.title}
              </b>{" "}
              <span className="muted small">
                {r.type} · released {dateTime(r.releasedAt)}
              </span>
              {r.onchain && (
                <span className="small">
                  {" "}
                  ·{" "}
                  {r.onchain.txUrl ? (
                    <a href={r.onchain.txUrl} target="_blank" rel="noreferrer">
                      recorded on-chain
                    </a>
                  ) : (
                    "recorded on-chain"
                  )}
                </span>
              )}
              <ul className="pp-signers">
                {r.signers.map((s) => (
                  <li key={s.meaning}>
                    {MEANING[s.meaning] ?? s.meaning} <span className="mono" title={s.address}>{s.ens ?? shortAddr(s.address)}</span>
                    {s.stake && (
                      <span className={`tag ${s.stake.active ? "ok" : "warn"}`}>
                        {s.stake.active ? "staked" : "not staked now"} {fromUnits(s.stake.amount, s.stake.decimals)} {s.stake.symbol}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      <section className="pp-card">
        <h2>Stage by stage</h2>
        <div className="scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>Stage</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {x.stages.map((s) => (
                <tr key={s.code}>
                  <td>
                    <b>{s.code}</b> {s.name}
                    <div className="faint small">{s.resource}</div>
                    {s.criteria.map((c) => (
                      <div key={c.label} className="small">
                        {c.ok === null ? "·" : c.ok ? "✓" : "✕"} {c.label} {c.target}
                        {c.zk && (
                          <>
                            {" "}
                            <span className={`tag ${c.zk.verified ? "ok" : c.zk.status === "pending" ? "warn" : "bad"}`} title={c.zk.detail}>
                              {c.zk.status === "proven" ? (c.zk.verified ? "ZK proof verified" : "ZK proof invalid") : c.zk.status === "pending" ? "ZK proof pending" : "no ZK proof"}
                            </span>
                          </>
                        )}
                      </div>
                    ))}
                  </td>
                  <td>{s.state.replaceAll("_", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="pp-card">
        <h2>Signed decisions</h2>
        {x.signed.length === 0 ? (
          <p className="muted small">No person signed a decision on this lot.</p>
        ) : (
          <ul className="pp-list">
            {x.signed.map((d, i) => (
              <li key={`${d.ledgerSeq ?? i}`}>
                <span>{d.summary}</span>
                <span className="faint small">
                  {" "}
                  · signed by <span className="mono" title={d.by}>{d.ens ?? shortAddr(d.by)}</span> · {dateTime(d.at)}
                  {d.ledgerSeq ? ` · ledger #${d.ledgerSeq}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="faint small">Agents recorded {x.agentDecisions} further decisions on this lot. Every human decision is an EIP-712 signature from the person's own wallet.</p>
      </section>
      <footer className="faint small pp-foot">Ordo · autonomous manufacturing orchestration, with proof</footer>
    </div>
  );
}
