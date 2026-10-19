/** ENS names for assets and agents, e.g. cnc-05.ordo-mfg.eth, resolved on Sepolia with viem. */
import { createPublicClient, http } from "viem";
import { normalize } from "viem/ens";
import { sepolia } from "viem/chains";
import type { Config } from "../config.js";
import type { IdentityResolver } from "../adapters/rails.js";

export class EnsIdentity implements IdentityResolver {
  readonly kind = "ens";
  private client;
  private cache = new Map<string, { name: string | null; at: number }>();
  constructor(private cfg: Config) {
    if (!cfg.ENS_PARENT_NAME) throw new Error("IDENTITY=ens needs ENS_PARENT_NAME");
    this.client = createPublicClient({ chain: sepolia, transport: http(cfg.ENS_RPC_URL) });
  }

  nameFor(id: string): string {
    return normalize(`${id.toLowerCase()}.${this.cfg.ENS_PARENT_NAME}`);
  }

  async names(ids: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    await Promise.all(
      ids.map(async (id) => {
        const hit = this.cache.get(id);
        if (hit && Date.now() - hit.at < 10 * 60_000) {
          out[id] = hit.name;
          return;
        }
        const name = this.nameFor(id);
        // A name counts only if its record says it is an Ordo entity.
        const type = await this.client.getEnsText({ name, key: "com.ordo.type" }).catch(() => null);
        out[id] = type ? name : null;
        this.cache.set(id, { name: out[id] ?? null, at: Date.now() });
      }),
    );
    return out;
  }
}
