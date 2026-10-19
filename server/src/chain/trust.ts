import { createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes, type Address, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { TypedSignature } from "../auth/auth.js";
import { ORDO_TRUST_ABI } from "./ordo-trust-abi.js";

/** On-chain role bits in OrdoTrust. */
export const CHAIN_ROLE = { OPERATOR: 1, SUPERVISOR: 2, VALIDATOR: 4, PLANT_MANAGER: 8, ADMIN: 16, VENDOR: 32 } as const;
export type ChainRole = keyof typeof CHAIN_ROLE;

export interface TrustChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string | null;
  address: Address;
  relayerKey: Hex;
  symbol: string;
  /** decimals of msg.value inside the contract: 8 on Hedera (tinybars), 18 elsewhere */
  decimals: number;
}

export interface TrustInfo {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string | null;
  address: string;
  symbol: string;
  decimals: number;
  minStake: string;
  unstakeCooldownSeconds: number;
  relayer: string;
}

type SigArg = { action: string; entity: string; meaning: string; comment: string; site: string; nonce: string; issuedAt: string; signature: Hex };
export const sigArg = (typed: TypedSignature, signature: string): SigArg => ({ ...typed.message, signature: signature as Hex });

/**
 * The OrdoTrust contract: roles as non-transferable credentials, validator stakes, releases and
 * slashing. Writes are relayed by Ordo's relayer key, but every one carries a person's EIP-712
 * signature that the contract verifies itself.
 */
export class TrustChain {
  private pub;
  private wallet;
  readonly relayer: Address;
  private infoCache: TrustInfo | null = null;

  constructor(
    readonly cfg: TrustChainConfig,
    transport?: Transport,
  ) {
    const chain = defineChain({ id: cfg.chainId, name: cfg.name, nativeCurrency: { name: cfg.symbol, symbol: cfg.symbol, decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
    const t = transport ?? http(cfg.rpcUrl, { timeout: 20_000 });
    const account = privateKeyToAccount(cfg.relayerKey);
    this.relayer = account.address;
    this.pub = createPublicClient({ chain, transport: t });
    this.wallet = createWalletClient({ chain, transport: t, account });
  }

  private read<T>(functionName: string, args: unknown[]): Promise<T> {
    return this.pub.readContract({ address: this.cfg.address, abi: ORDO_TRUST_ABI, functionName, args } as never) as Promise<T>;
  }
  private async write(functionName: string, args: unknown[]): Promise<Hex> {
    const { request } = await this.pub.simulateContract({ address: this.cfg.address, abi: ORDO_TRUST_ABI, functionName, args, account: this.wallet.account } as never);
    const hash = await this.wallet.writeContract(request as never);
    const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return hash;
  }

  async info(): Promise<TrustInfo> {
    if (this.infoCache) return this.infoCache;
    const [minStake, cooldown] = await Promise.all([this.read<bigint>("minStake", []), this.read<bigint>("unstakeCooldown", [])]);
    this.infoCache = {
      chainId: this.cfg.chainId,
      name: this.cfg.name,
      rpcUrl: this.cfg.rpcUrl,
      explorerUrl: this.cfg.explorerUrl,
      address: this.cfg.address,
      symbol: this.cfg.symbol,
      decimals: this.cfg.decimals,
      minStake: minStake.toString(),
      unstakeCooldownSeconds: Number(cooldown),
      relayer: this.relayer,
    };
    return this.infoCache;
  }

  txUrl(hash: string): string | null {
    return this.cfg.explorerUrl ? `${this.cfg.explorerUrl.replace(/\/$/, "")}/tx/${hash}` : null;
  }

  async siteRegistered(siteId: string): Promise<boolean> {
    const s = await this.read<readonly [boolean, Address]>("sites", [await this.read<Hex>("siteKey", [siteId])]);
    return s[0];
  }
  roles(siteId: string, account: string): Promise<number> {
    return this.read<bigint | number>("roles", [this.keyOf(siteId), account]).then(Number);
  }
  isActiveValidator(siteId: string, account: string): Promise<boolean> {
    return this.read<boolean>("isActiveValidator", [siteId, account]);
  }
  async stakeOf(siteId: string, account: string): Promise<{ amount: string; unlockAt: number }> {
    const s = await this.read<readonly [bigint, bigint]>("stakes", [this.keyOf(siteId), account]);
    return { amount: s[0].toString(), unlockAt: Number(s[1]) };
  }
  private keyOf(siteId: string): Hex {
    // keccak256(bytes(siteId)), same as OrdoTrust.siteKey
    return keccakUtf8(siteId);
  }

  registerSite(siteId: string, treasury: string, sig: SigArg) {
    return this.write("registerSite", [siteId, treasury, sig]);
  }
  grantRole(siteId: string, account: string, role: ChainRole, sig: SigArg) {
    return this.write("grantRole", [siteId, account, CHAIN_ROLE[role], sig]);
  }
  recordRelease(siteId: string, packageId: string, contentHash: Hex, sigs: [SigArg, SigArg, SigArg]) {
    return this.write("recordRelease", [siteId, packageId, contentHash, sigs]);
  }
  slash(siteId: string, validator: string, amount: bigint, proposalId: string, sigs: [SigArg, SigArg, SigArg]) {
    return this.write("slash", [siteId, validator, amount, proposalId, sigs]);
  }
}

const keccakUtf8 = (s: string): Hex => keccak256(toBytes(s));
