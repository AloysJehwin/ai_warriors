import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { loadConfig } from "../../src/config.js";
import { createApp } from "../../src/http/app.js";
import { buildSystem, type System } from "../../src/wiring.js";

export async function boot(env: Record<string, string> = {}, opts: Parameters<typeof buildSystem>[1] = {}) {
  const cfg = loadConfig({ DATA_DIR: "memory", POLICY_FILE: resolve(__dirname, "../../../policies/default.yaml"), ...env } as NodeJS.ProcessEnv);
  const sys = await buildSystem(cfg, opts);
  const app = createApp(sys);
  return { sys, app };
}

export interface Client {
  account: PrivateKeyAccount;
  address: string;
  call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }>;
  sign(typed: any): Promise<`0x${string}`>;
  upload<T = any>(path: string, form: FormData): Promise<{ status: number; json: T }>;
  /** a signed-in request whose body is not JSON (a stored evidence file) */
  raw(method: string, path: string): Promise<Response>;
}

/** A browser-like client with its own wallet and session cookie. */
export async function wallet(app: ReturnType<typeof createApp>, key: `0x${string}` = generatePrivateKey()): Promise<Client> {
  const account = privateKeyToAccount(key);
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const { json } = await call("POST", "/v1/auth/nonce");
  const message = createSiweMessage({ domain: json.domain, address: account.address, statement: "Sign in to Ordo", uri: json.uri, version: "1", chainId: 296, nonce: json.nonce });
  const signature = await account.signMessage({ message });
  const r = await call("POST", "/v1/auth/verify", { message, signature });
  if (r.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(r.json)}`);
  const upload = async (path: string, form: FormData) => {
    const res = await app.request(path, { method: "POST", body: form, headers: { host: "localhost", origin: "http://localhost", cookie } });
    return { status: res.status, json: await res.json() };
  };
  const raw = async (method: string, path: string) => app.request(path, { method, headers: { host: "localhost", origin: "http://localhost", cookie } });
  return { account, address: account.address.toLowerCase(), call, upload, raw, sign: (typed) => account.signTypedData(asTyped(typed)) };
}

/** Typed data as the server sends it (JSON): uint fields arrive as decimal strings, as the console converts them. */
export function asTyped(typed: any) {
  const fields: { name: string; type: string }[] = typed.types[typed.primaryType] ?? [];
  const message = { ...typed.message };
  for (const f of fields) if (/^uint/.test(f.type) && typeof message[f.name] === "string") message[f.name] = BigInt(message[f.name]);
  return { ...typed, message };
}

export type { System };
