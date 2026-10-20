import { createHash } from "node:crypto";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { HttpError } from "../engine/errors.js";

export interface WorldIdConfig {
  appId: `app_${string}`;
  rpId: string;
  /** the RP signing key from the Developer Portal; it signs each request so World App knows it came from Ordo */
  signingKey: string;
  action: string;
  environment: "production" | "sandbox" | "staging";
  verifyBase: string;
}

/** What the browser needs to open a World ID request: the app, the action and a fresh RP signature. */
export interface WorldIdRequest {
  appId: string;
  action: string;
  environment: WorldIdConfig["environment"];
  rpContext: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string };
}

interface ResultItem {
  identifier?: string;
  signal_hash?: string;
  nullifier?: string;
}
/** The IDKit result as the widget hands it over (protocol 3.0 or 4.0); it is forwarded to the Developer Portal unchanged. */
export interface WorldIdResult {
  protocol_version?: string;
  action?: string;
  environment?: string;
  responses?: ResultItem[];
  [k: string]: unknown;
}

/**
 * World ID proof of personhood for validators. The proof's signal is the applicant's wallet, so a proof
 * can't be replayed from another wallet, and its nullifier is the same for one person however many wallets
 * they hold: Ordo keeps one nullifier per validator per site, which is what stops one person signing
 * "reviewed" and "approved" from two wallets. Proofs are checked by the World Developer Portal.
 */
export class WorldId {
  constructor(
    readonly cfg: WorldIdConfig,
    private fetcher: typeof fetch = fetch,
  ) {}

  request(): WorldIdRequest {
    const s = signRequest({ signingKeyHex: this.cfg.signingKey, action: this.cfg.action });
    return {
      appId: this.cfg.appId,
      action: this.cfg.action,
      environment: this.cfg.environment,
      rpContext: { rp_id: this.cfg.rpId, nonce: s.nonce, created_at: s.createdAt, expires_at: s.expiresAt, signature: s.sig },
    };
  }

  /** The signal a validator's proof must carry: their wallet address, lower-case. */
  static signalOf(address: string) {
    return address.toLowerCase();
  }

  /** Check a proof made for `address`; returns the person's nullifier for Ordo's action. */
  async verify(result: unknown, address: string): Promise<{ nullifier: string }> {
    const r = (result ?? {}) as WorldIdResult;
    const item = r.responses?.[0];
    if (!item?.nullifier) throw new HttpError(400, "Verify with World ID first");
    if (r.action !== undefined && r.action !== this.cfg.action) throw new HttpError(400, "This World ID proof is for a different action");
    if (r.environment !== undefined && r.environment !== this.cfg.environment) throw new HttpError(400, `This World ID proof is from ${r.environment}, not ${this.cfg.environment}`);
    const want = hashSignal(WorldId.signalOf(address)).toLowerCase();
    if (!r.responses!.every((x) => x.signal_hash?.toLowerCase() === want)) throw new HttpError(400, "This World ID proof was made for a different wallet");
    const res = await this.fetcher(`${this.cfg.verifyBase.replace(/\/$/, "")}/api/v4/verify/${encodeURIComponent(this.cfg.rpId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(r),
    }).catch(() => null);
    if (!res) throw new HttpError(502, "Could not reach World ID to check the proof. Try again.");
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; code?: string; detail?: string };
    if (!res.ok || body.success === false) throw new HttpError(400, `World ID did not accept the proof${body.detail || body.code ? `: ${body.detail ?? body.code}` : ""}`);
    return { nullifier: item.nullifier.toLowerCase() };
  }

  /** What the public ledger records instead of the nullifier, so one person can't be linked across sites. */
  static ledgerRef(siteId: string, nullifier: string) {
    return `sha256:${createHash("sha256").update(`${siteId}\n${nullifier}`).digest("hex")}`;
  }
}
