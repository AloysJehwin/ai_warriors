export type {
  AgentKey,
  AnchorDto,
  AssetKind,
  AssetStatus,
  AssetView,
  AutonomyLevel,
  Criterion,
  DataSource,
  DecisionView,
  InboxItemView,
  InboxOption,
  LedgerEntryDto,
  PackageType,
  Role,
  RunStatus,
  RunView,
  SignalLimit,
  StageMode,
  StageRunView,
  StageSpec,
  StageState,
  TemplateSpec,
  TemplateView,
} from "../../server/src/domain/types";
import type { AgentKey, AutonomyLevel, Role, StageMode } from "../../server/src/domain/types";
export type StageModeT = typeof StageMode extends { options: readonly (infer X)[] } ? X : never;

export interface Me {
  user: { id: string; address: string; displayName: string | null; ens: string | null } | null;
  memberships: { siteId: string; siteName: string; roles: Role[] }[];
  canCreateSite: boolean;
}
export interface Site {
  id: string;
  name: string;
  timezone: string;
  publicPipelines: boolean;
  lines: { id: string; name: string; autonomy: AutonomyLevel }[];
  zones: { id: string; name: string; sort: number }[];
  myRoles: Role[];
}
export interface Meta {
  roles: { key: Role; label: string }[];
  agents: { key: AgentKey; label: string; scope: string }[];
  assetKinds: { key: string; label: string }[];
  categories: string[];
  packageTypes: string[];
}
export interface Status {
  rails: { rail: string; mode: string; live: boolean }[];
  warnings: string[];
  policy: { id: string; version: number; hash: string };
  build: { env: string; commit: string | null } | null;
  signatureChainId: number;
  restrictedSiteCreation: boolean;
  trust: TrustChainInfo | null;
  /** set when validators must prove with World ID that they are one person */
  worldId: { appId: string; action: string; environment: string } | null;
}
export interface TrustChainInfo {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string | null;
  address: string;
  symbol: string;
  /** decimals of native value inside the contract (8 on Hedera, 18 elsewhere) */
  decimals: number;
  /** OrdoWorkOrders and OrdoPolicies on the same chain, when deployed */
  workOrders?: string | null;
  policies?: string | null;
}
export interface RelayView {
  kind: string;
  status: "pending" | "done" | "failed" | "waiting_site";
  txHash: string | null;
  txUrl: string | null;
  error: string | null;
}
export type OnboardingKind = "member" | "validator" | "vendor";
export interface OnboardingView {
  id: string;
  siteId: string;
  siteName?: string;
  userId: string;
  address: string;
  name: string | null;
  kind: OnboardingKind;
  role: string;
  roleLabel: string;
  form: Record<string, string>;
  files: { name: string; sha256: string; size: number; mime: string }[];
  status: "pending" | "approved" | "rejected";
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  createdAt: string;
  chain: RelayView | null;
}
export interface ChainStatus {
  configured: boolean;
  info?: { chainId: number; name: string; address: string; symbol: string; decimals: number; minStake: string; unstakeCooldownSeconds: number; relayer: string; explorerUrl: string | null } | { error: string };
  registered?: boolean;
  txHash?: string | null;
  txUrl?: string | null;
  registeredAt?: string | null;
}
export interface ValidatorsView {
  validators: { userId: string; address: string; name: string | null; scope: string; scopeLabel: string; status: string; approvedAt: string; human: boolean; onchain: { stake: string; unlockAt: number; active: boolean; payout: ScheduleView | null } | null }[];
  me: { ok: boolean; reason: string | null; row: { scope: string; status: string } | null; human: boolean };
  chain: ChainStatus;
  proposals: {
    id: string;
    validatorUserId: string;
    validatorAddress: string;
    amount: string;
    reason: string;
    recallPackageId: string | null;
    createdBy: string;
    status: string;
    createdAt: string;
    executedAt: string | null;
    signatures: { userId: string; address: string; capacity: string; at: string }[];
    chain: RelayView | null;
  }[];
}
export interface VendorRow {
  id: string;
  address: string;
  company: string;
  categories: string;
  hourlyRate: string | null;
  responseMinutes: number | null;
  status: string;
  createdAt: string;
}
export interface OrdoSignatureTyped {
  /** version 2 names the contract that checks it (OrdoTrust), so it cannot be replayed on another deployment */
  domain: { name: "Ordo"; version: "1" | "2"; chainId: number; verifyingContract?: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "OrdoSignature";
  message: { action: string; entity: string; meaning: string; comment: string; site: string; nonce: string; issuedAt: string };
}
/** A release statement: names the lot, the content and the root of its stage proofs; no chain, so both release contracts check the same signature. */
export interface ReleaseTyped {
  domain: { name: "Ordo"; version: "2" };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "OrdoRelease";
  message: { site: string; packageId: string; runId: string; lot: string; meaning: string; statement: string; comment: string; contentHash: string; proofRoot: string; nonce: string; deadline: string };
}
/** A stage's counts as their source signs them: a commitment, never the counts. */
export interface ReadingTyped {
  domain: { name: "Ordo"; version: "2" };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "OrdoReading";
  message: { site: string; runId: string; stage: string; asset: string; commitment: string; anchor: string; signedAt: string };
}
export type TypedSignature = OrdoSignatureTyped | ReleaseTyped;
export interface Team {
  members: { userId: string; address: string; name: string | null; ens: string | null; roles: Role[]; lastSeenAt: string | null }[];
  invites: { id: string; address: string; role: Role; createdAt: string }[];
}
export interface AgentRow {
  key: AgentKey;
  label: string;
  scope: string;
  autonomy: AutonomyLevel;
  assets: { id: string; name: string; status: string }[];
  currentTask: string | null;
  activeStages: number;
  decisionsToday: number;
  escalationsToday: number;
  avgConfidence: number | null;
  /** The agent's ERC-7857 iNFT on 0G, when configured */
  inft: {
    contract: string;
    tokenId: number | null;
    status: "pending" | "synced" | "failed";
    error: string | null;
    url: string | null;
    txUrl: string | null;
    data: { dataDescription: string; dataHash: string }[];
    authorizedUsers: string[];
  } | null;
  /** How often people accepted what it recommended; proven agents can be licensed to other sites */
  record: TrackRecord;
  /** Agents of the same kind this site licenses from other sites (their playbooks feed this agent) */
  licensedFrom: { id: string; site: string; tokenId: number | null; tokenUrl: string | null; expiresAt: string | null }[];
}
export interface TrackRecord {
  recommended: number;
  decided: number;
  accepted: number;
  overridden: number;
  rate: number | null;
  proven: boolean;
}
export type LicenseStatus = "requested" | "declined" | "signed" | "active" | "revoking" | "revoked" | "expired" | "failed";
export interface AgentLicense {
  id: string;
  agent: AgentKey;
  agentLabel: string;
  licensor: { id: string; name: string };
  licensee: { id: string; name: string };
  tokenId: number | null;
  tokenUrl: string | null;
  status: LicenseStatus;
  days: number;
  expiresAt: string | null;
  termsHash: string | null;
  record: TrackRecord | null;
  cases: number;
  playbookSha256: string | null;
  storage: { root: string; url: string } | null;
  txUrl: string | null;
  error: string | null;
  requestedBy: string;
  grantedBy: string | null;
  createdAt: string;
}
export interface MarketAgent {
  site: { id: string; name: string };
  agent: AgentKey;
  label: string;
  scope: string;
  tokenId: number | null;
  tokenUrl: string | null;
  record: TrackRecord;
  license: AgentLicense | null;
}
export interface Incident {
  id: string;
  assetId: string;
  status: string;
  title: string;
  severity: string;
  openedAt: string;
  closedAt: string | null;
}
export interface PackageSummary {
  id: string;
  number: number;
  code: string;
  type: string;
  typeLabel: string;
  title: string;
  status: "draft" | "in_review" | "changes_requested" | "rejected" | "released";
  step: string;
  stepIndex: number;
  waitingOn: string | null;
  needsMe: boolean;
  owner: { address: string; name: string | null };
  runId: string | null;
  stageCode: string | null;
  checks: { total: number; done: number };
  updatedAt: string;
}
export interface PackageDetail extends Omit<PackageSummary, "owner" | "waitingOn" | "needsMe" | "checks"> {
  owner: { id: string; address: string; name: string | null };
  objective: string;
  acceptance: string;
  samplePlan: string;
  windowStart: string | null;
  windowEnd: string | null;
  templateId: string | null;
  assetId: string | null;
  outcome: string;
  returnedComment: string | null;
  assessment: { ranAt: string; agent: string; summary: string; figures: { label: string; value: string }[]; confidence: number | null } | null;
  checks: { id: string; criterion: string; method: string; target: string; source: string; result: string | null; actual: string | null; status: "pending" | "pass" | "fail"; auto: boolean; recordedBy: string | null; recordedAt: string | null }[];
  evidence: { id: string; name: string; requirement: string; required: boolean; filename: string | null; mime: string | null; size: number | null; sha256: string | null; uploadedBy: string | null; uploadedAt: string | null; origin: string; version: number; removedAt: string | null; zeroG: { status: "pending" | "done" | "failed"; root: string | null; url: string | null; error: string | null } | null }[];
  chain: { meaning: string; label: string; role: Role; roleLabel: string; state: "signed" | "awaiting" | "pending" | "returned"; signer: { address: string; name: string | null } | null; signedAt: string | null; signature: string | null; comment: string | null }[];
  readiness: { ready: boolean; items: { label: string; ok: boolean }[] };
  audit: { seq: number; ts: string; actor: string; type: string; payload: Record<string, unknown>; entryHash: string }[];
  createdAt: string;
  onchain: RelayView | null;
}
export interface VerifyReport {
  ok: boolean;
  entries: number;
  headSeq: number;
  headHash: string | null;
  broken: { seq: number; ok: boolean; reason?: string }[];
  anchors: { id: number; kind: string; toSeq: number; entryHash: string; ref: string; url: string | null; ts: string; matchesChain: boolean; external: { ok: boolean; detail: string } }[];
  subject: { id: string; entries: { seq: number; ts: string; actor: string; type: string; entryHash: string; ok: boolean }[] } | null;
}
export type Mode = StageModeT;

// ---------------- Work orders: the maintenance agent pays vendors ----------------
export type WorkOrderStatus = "unassigned" | "assigned" | "escrowing" | "escrowed" | "escrow_failed" | "releasing" | "released" | "refunded";
export interface WorkOrderView {
  id: string;
  title: string;
  priority: string;
  assetId: string | null;
  runId: string | null;
  vendor: { id: string; company: string; address: string } | null;
  /** contract units (tinybars on Hedera) */
  amount: string | null;
  status: WorkOrderStatus;
  payer: string | null;
  escrow: { tx: string; url: string | null; expiresAt: string | null } | null;
  releasedBy: string | null;
  error: string | null;
  openedBy: string;
  createdAt: string;
  updatedAt: string;
  release: RelayView | null;
  /** The vibration assessment the agent bought over x402 */
  assessment: AssessmentView | null;
  /** The Hedera schedule that refunds the escrow if nobody releases it */
  refundSchedule: ScheduleView | null;
}
export interface AssessmentView {
  status: "pending" | "done" | "failed";
  error: string | null;
  skipped: string | null;
  assessment: { standard: string; zone: "A" | "B" | "C" | "D"; verdict: string; level: number; peak: number; slopePerHour: number; hoursToZoneD: number | null; samples: number } | null;
  payment: { transaction: string; url: string; payer: string | null; network: string } | null;
}
export interface WorkOrdersSetup {
  configured: boolean;
  contract: string | null;
  chainId: number | null;
  chainName: string | null;
  explorerUrl: string | null;
  symbol: string | null;
  decimals: number | null;
  agent: { address: string; via: string } | null;
  caps: { perOrder: string; perDay: string; setBy: string; updatedAt: string } | null;
  capsRelay: RelayView | null;
  siteRegistered: boolean;
  onchain: { funds: string; paused: boolean; perOrder: string; perDay: string; spentToday: string } | { error: string } | null;
}
export interface WorkOrdersResponse {
  setup: WorkOrdersSetup;
  items: WorkOrderView[];
}

// ---------------- Autonomy proposals: two plant managers to raise ----------------
export interface AutonomyProposalView {
  id: string;
  lineId: string;
  lineName: string;
  from: AutonomyLevel;
  to: AutonomyLevel;
  version: number;
  comment: string;
  status: "open" | "applied" | "superseded";
  required: number;
  signers: { address: string; name: string | null; at: string }[];
  createdBy: string;
  createdAt: string;
  decidedAt: string | null;
  onchain: RelayView | null;
}

// ---------------- Lot passports ----------------
export type PassportStatus = "in_production" | "held" | "completed" | "aborted" | "shipped";
export interface PassportView {
  runId: string;
  status: PassportStatus;
  pageUrl: string;
  nft: { tokenId: string; serial: number | null; url: string | null; onchainStatus: string | null; mintTxUrl: string | null; error: string | null } | null;
  shipment: { to: string; at: string; txUrl: string | null; pending: boolean | null } | null;
  /** the lot's own ENS name, and its releases recorded there against the signers' ENS credentials */
  ens?: { name: string; url: string; releases: { packageId: string; status: "pending" | "done" | "failed"; txUrl: string | null; error: string | null }[] } | null;
}
export interface SpecProof {
  status: "proven" | "pending" | "failed";
  system: "groth16-bn254";
  circuit: "spec_check";
  /** [subject, target × 10⁴, op, commitment] */
  publicSignals: string[] | null;
  proof: unknown;
  ledgerSeq: number | null;
  verified: boolean | null;
  detail: string;
}
/** A stage's counts signed at their source (its machine's gateway, or the operator), and the zero-knowledge proof they meet its criteria. */
export interface StageWork {
  stage: string;
  signer: string;
  signerKind: "device" | "operator";
  signerEns: string | null;
  matches: boolean;
  commitment: string;
  anchor: string;
  signedAt: string;
  status: "proven" | "pending" | "failed" | "not_met";
  criteria: string[];
  system: "groth16-bn254";
  circuit: "stage_check";
  publicSignals: string[] | null;
  proof: unknown;
  verified: boolean | null;
  detail: string;
  reading: { site: string; runId: string; stage: string; asset: string; commitment: string; anchor: string; signedAt: string; signature: string };
}
export interface PublicPassport {
  name: string;
  creator: string;
  description: string;
  properties: { runId: string; status: PassportStatus; orderRef: string; quantity: number; product: string };
  passport: PassportView & {
    site: string | null;
    orderRef: string;
    quantity: number;
    product: { name: string; category: string; version: number };
    startedAt: string;
    finishedAt: string | null;
    stages: {
      code: string;
      name: string;
      state: string;
      mode: string;
      resource: string;
      startedAt: string | null;
      endedAt: string | null;
      /** whether each criterion was met; the measurement stays private, with a zero-knowledge proof where it was met */
      criteria: { label: string; target: string; ok: boolean | null; zk: SpecProof | null }[];
      deviation: boolean;
      /** proof of work: who signed the stage's counts where they were made, and the proof they meet its criteria */
      work: StageWork | null;
    }[];
    signed: { kind: string; summary: string; stageCode: string | null; by: string; ens: string | null; at: string; ledgerSeq: number | null }[];
    agentDecisions: number;
    releases: {
      id: string;
      number: number;
      type: string;
      title: string;
      releasedAt: string;
      signers: { meaning: string; address: string; ens: string | null; stake: { amount: string; active: boolean; symbol: string; decimals: number } | null }[];
      onchain: { txUrl: string | null; contract: string | null } | null;
      /** what the three signed: the lot, the content hash and the root of its stage proofs */
      statement: { lot: string; contentHash: string; proofRoot: string; stagesProven: string[] } | null;
    }[];
    proof: {
      chainIntact: boolean;
      headSeq: number;
      entries: number;
      lastSeq: number;
      anchor: { kind: string; ref: string; url: string | null; toSeq: number; at: string; matchesChain: boolean; external: { ok: boolean; detail: string } } | null;
      checkedAt: string;
    };
  };
}

// ---------------- ENS names (ENSv2 on Sepolia) ----------------
export interface EnsNameView {
  kind: "site" | "person" | "asset" | "agent" | "device";
  ref: string;
  name: string;
  status: "pending" | "issued" | "revoked" | "failed";
  error: string | null;
  url: string;
  txUrl: string | null;
  records: Record<string, string>;
}
export interface EnsNamesResponse {
  live: boolean;
  parent: string | null;
  items: EnsNameView[];
}

// ---------- Public pipelines (no sign-in) ----------
export interface OpenRole {
  kind: "member" | "validator";
  role: string;
  label: string;
  why: string[];
  holders: number;
}
export interface PublicPipeline {
  siteId: string;
  site: string;
  runId: string;
  pipeline: { name: string; category: string; description: string; version: number };
  status: string;
  quantity: number;
  startedAt: string;
  dueAt: string | null;
  metrics: { completed: number; total: number; gatesPending: number; rolledYield: number | null; onTrack: boolean | null };
  stages: { code: string; column: number; name: string; state: string; mode: string; agent: string; resource: string; gateRole: string; progress: number }[];
  roles: OpenRole[];
  validation?: { ref: string; type: string; status: string; stageCode: string | null; waitingFor: { meaning: string; label: string; role: string; roleLabel: string } | null }[];
}

/** A deadline Hedera's Schedule Service runs on its own */
export interface ScheduleView {
  kind: "workorder.refund" | "stake.withdraw" | "stage.timeout";
  status: "scheduled" | "executed" | "cancelled" | "failed" | "skipped";
  executeAt: string;
  scheduleId: string | null;
  url: string | null;
  executedAt: string | null;
  error: string | null;
}

// ---------------- Machine wallets: machines that pay for themselves over x402 ----------------
export interface MachinePurchase {
  id: string;
  kind: "assessment" | "callout";
  seller: string;
  amount: string | null;
  txId: string | null;
  txUrl: string | null;
  auditTx: string | null;
  incidentId: string | null;
  result: Record<string, unknown> | null;
  at: string;
}
export interface MachineWallet {
  assetId: string;
  status: "opening" | "active" | "paused" | "failed";
  accountId: string | null;
  accountUrl: string | null;
  evmAddress: string | null;
  dailyBudget: string;
  perCall: string;
  balance: string | null;
  lastTopUpAt: string | null;
  error: string | null;
  purchases: MachinePurchase[];
}

// ---------------- Pay on proof ----------------
export type PartyKind = "plant" | "customer" | "financier";
export interface FinanceParty {
  id: string;
  kind: PartyKind;
  name: string;
  status: "opening" | "active" | "failed";
  accountId: string | null;
  accountUrl: string | null;
  address: string | null;
  balance: string | null;
  error: string | null;
}
export interface FinanceOrder {
  id: string;
  packageId: string;
  packageTitle: string;
  packageStatus: string;
  runId: string | null;
  customer: { id: string; name: string };
  payee: { id: string; name: string; kind: PartyKind };
  amount: string;
  ask: string | null;
  expiresAt: string;
  status: "funding" | "open" | "paid" | "refunded" | "failed";
  holdId: string | null;
  key: string | null;
  txs: { kind: string; hash: string; url: string | null; at: string }[];
  note: string | null;
  error: string | null;
  createdAt: string;
}
export interface FinanceResponse {
  live: boolean;
  coin: { symbol: string; decimals: number; address: string; token: string; contract: string; studio: string } | null;
  parties: FinanceParty[];
  orders: FinanceOrder[];
}
