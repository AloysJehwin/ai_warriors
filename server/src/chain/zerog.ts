/**
 * 0G adapters. The SDKs are optional dependencies (install them when enabling 0G):
 *   pnpm --filter @ordo/server add @0glabs/0g-serving-broker @0gfoundation/0g-ts-sdk ethers
 * Package names and APIs move quickly; check docs.0g.ai before the demo.
 */
import type { Config } from "../config.js";
import { openAiCompatProvider, type LlmProvider } from "../adapters/llm.js";
import type { EvidenceStore } from "../adapters/rails.js";
import { sha256 } from "../domain/canonical.js";

// biome-ignore lint: dynamic optional import
const optional = async (name: string): Promise<any> => import(/* @vite-ignore */ name);

async function signer(cfg: Config) {
  if (!cfg.ZG_PRIVATE_KEY) throw new Error("0G needs ZG_PRIVATE_KEY");
  const { ethers } = await optional("ethers");
  return new ethers.Wallet(cfg.ZG_PRIVATE_KEY, new ethers.JsonRpcProvider(cfg.ZG_RPC_URL));
}

/** Root-cause and recommendation inference on 0G Compute (OpenAI-compatible provider endpoint). */
export async function zeroGComputeProvider(cfg: Config): Promise<LlmProvider> {
  const { createZGComputeNetworkBroker } = await optional("@0glabs/0g-serving-broker");
  const broker = await createZGComputeNetworkBroker(await signer(cfg));
  let provider = cfg.ZG_PROVIDER_ADDRESS;
  if (!provider) {
    const services = (await broker.inference.listService()) as { provider: string }[];
    provider = services[0]?.provider;
  }
  if (!provider) throw new Error("No 0G inference provider available");
  await broker.inference.acknowledgeProviderSigner?.(provider).catch(() => undefined);
  const { endpoint, model } = (await broker.inference.getServiceMetadata(provider)) as { endpoint: string; model: string };
  return openAiCompatProvider({
    name: "0g-compute",
    baseUrl: endpoint,
    model,
    timeoutMs: cfg.LLM_TIMEOUT_MS,
    headers: async (body) => (await broker.inference.getRequestHeaders(provider, body)) as Record<string, string>,
  });
}

/** Evidence bundles on 0G Storage; the Merkle root hash is the evidence id. */
export class ZeroGStorage implements EvidenceStore {
  readonly kind = "0g-storage";
  constructor(private cfg: Config) {}
  async put(bytes: Uint8Array): Promise<{ uri: string; sha256: string }> {
    const { Indexer, MemData } = await optional("@0gfoundation/0g-ts-sdk");
    const file = new MemData(bytes);
    const [tree, treeErr] = await file.merkleTree();
    if (treeErr) throw new Error(`0G merkle tree: ${treeErr}`);
    const indexer = new Indexer(this.cfg.ZG_INDEXER_URL);
    const [, upErr] = await indexer.upload(file, this.cfg.ZG_RPC_URL, await signer(this.cfg));
    if (upErr) throw new Error(`0G upload: ${upErr}`);
    return { uri: `0g:${tree.rootHash()}`, sha256: sha256(bytes) };
  }
}
