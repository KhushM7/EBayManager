// Calls the Worker's /api with K's session cookie. A 401 means "show sign-in".

export class SignedOut extends Error {}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-EbayManager": "1" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401 && path !== "/login") throw new SignedOut();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface Me {
  user: { id: string; name: string; role: "owner" | "manager" };
  ebayEnv: "sandbox" | "production";
  writeMode: string;
  writesPaused: boolean;
  writesBlocked: string | null;
  ebayConnected: boolean;
  ebayScopes: "read-only" | "full" | null;
  /** eBay stopped accepting the saved sign-in (after a username or password change): sign in again. */
  ebayNeedsReconnect?: boolean;
  vapidPublicKey: string | null;
  lastPushAt: number | null;
}

export interface Proposal {
  id: string;
  kind: string;
  item_id: string | null;
  item_title: string | null;
  item_price: number | null;
  payload: any;
  reason: string | null;
  status: string;
  dry_run: number;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  decided_by: string | null;
  result: string | null;
}

export interface Listing {
  item_id: string;
  title: string;
  price: number;
  currency: string;
  watch_count: number;
  view_count: number | null;
  quantity_available: number;
  start_time: string;
  image_url?: string | null;
  taken_at: number;
  floor_price: number | null;
  collection_only: number | null;
  pending: number;
}

export interface Activity {
  id: number;
  at: number;
  env: string;
  proposal_id: string | null;
  call: string;
  outcome: "applied" | "refused" | "failed";
  actor: string | null;
  response: string | null;
  kind: string | null;
  item_id: string | null;
}

export interface Device {
  endpoint: string;
  user_agent: string | null;
  created_at: number;
  last_ok_at: number | null;
  last_error: string | null;
}

/**
 * Calls an endpoint that may start a background job (the audit, a price check, Claude's listing review). If
 * the server queued it, waits for the job to finish (checking every few seconds, up to 40 minutes) and
 * returns its result, so callers see the same answer either way. `onQueued` lets the screen say it's running.
 */
export async function apiJob<T = any>(path: string, body: unknown, onQueued?: () => void): Promise<T> {
  const first = await api<any>(path, { body });
  if (!(first && first.status === "queued" && typeof first.jobId === "string")) return first as T;
  onQueued?.();
  const started = Date.now();
  while (Date.now() - started < 40 * 60_000) {
    await new Promise((r) => setTimeout(r, 4000));
    const s = await api<{ status: string; result: T; error: string | null }>(`/jobs/${first.jobId}`);
    if (s.status === "done") return s.result;
    if (s.status === "failed") throw new Error(s.error ?? "The job failed");
  }
  throw new Error("Still running after 40 minutes; you'll get a notification when it's done.");
}
