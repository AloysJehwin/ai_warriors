/** Empty when the console is served by the API; set VITE_API_BASE when hosting the console elsewhere. */
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, raw?: BodyInit, headers: Record<string, string> = {}): Promise<T> {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(`${API_BASE}${path}`, { method, headers: h, credentials: "include", body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new ApiError(res.status, (json as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown = {}) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown = {}) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
  upload: <T>(path: string, form: FormData) => request<T>("POST", path, undefined, form),
  text: <T>(path: string, text: string, contentType = "text/csv") => request<T>("POST", path, undefined, text, { "content-type": contentType }),
  url: (path: string) => `${API_BASE}${path}`,
};
