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
  validators: { userId: string; address: string; name: string | null; scope: string; scopeLabel: string; status: string; approvedAt: string; onchain: { stake: string; unlockAt: number; active: boolean } | null }[];
  me: { ok: boolean; reason: string | null; row: { scope: string; status: string } | null };
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
export interface TypedSignature {
  domain: { name: "Ordo"; version: "1"; chainId: number };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "OrdoSignature";
  message: { action: string; entity: string; meaning: string; comment: string; site: string; nonce: string; issuedAt: string };
}
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
    rolledYield: number | null;
    stages: {
      code: string;
      name: string;
      state: string;
      mode: string;
      resource: string;
      startedAt: string | null;
      endedAt: string | null;
      unitsGood: number;
      unitsScrap: number;
      criteria: { label: string; target: string; actual: string | null; ok: boolean | null }[];
      deviation: boolean;
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
  kind: "site" | "person" | "asset" | "agent";
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
