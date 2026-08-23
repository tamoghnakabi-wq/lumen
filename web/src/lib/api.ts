export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, message: string, code = "error", details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Options = Omit<RequestInit, "body"> & { json?: unknown; body?: BodyInit | null };

/**
 * Notified when the server rejects a request as unauthenticated, so the app can
 * drop its cached user instead of leaving a signed-out person staring at a
 * half-broken page. Sessions expire, are revoked from another device, or are
 * invalidated by a password change — the client has to cope with all three.
 */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  onUnauthorized = handler;
}

/** Paths where a 401 is an expected answer rather than a lost session. */
const AUTH_PROBE = /^\/auth\/(me|login|signup|reset|forgot|available)/;

/**
 * All requests are same-origin and relative, which is what makes the app work
 * unchanged on localhost, on a LAN address and behind a TryCloudflare hostname.
 */
export async function api<T = unknown>(path: string, options: Options = {}): Promise<T> {
  const { json, headers, ...rest } = options;
  const init: RequestInit = { credentials: "same-origin", ...rest };
  const h = new Headers(headers);
  if (json !== undefined) {
    h.set("content-type", "application/json");
    init.body = JSON.stringify(json);
  }
  init.headers = h;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, "You appear to be offline. Check your connection and try again.", "offline");
  }

  if (res.status === 204) return undefined as T;

  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    if (!res.ok) throw new ApiError(res.status, "Something went wrong. Please try again.", "bad_response");
    return undefined as T;
  }

  const body = await res.json();
  if (!res.ok) {
    if (res.status === 401 && !AUTH_PROBE.test(path)) onUnauthorized?.();
    throw new ApiError(res.status, body?.error ?? "Something went wrong.", body?.code ?? "error", body?.details);
  }
  return body as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, json?: unknown) => api<T>(path, { method: "POST", json });
export const patch = <T>(path: string, json?: unknown) => api<T>(path, { method: "PATCH", json });
export const del = <T>(path: string, json?: unknown) => api<T>(path, { method: "DELETE", json });
export const upload = <T>(path: string, body: FormData, method = "POST") => api<T>(path, { method, body });
