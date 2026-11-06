import type { Env } from "./env";
import { sendToAll } from "./push";

/** [SANDBOX] or [READ-ONLY] on every push, so a test can't be mistaken for the real account. */
export function envPrefix(env: Pick<Env, "EBAY_ENV" | "WRITE_MODE">): string {
  if (env.EBAY_ENV !== "production") return "[SANDBOX] ";
  return env.WRITE_MODE === "approval" ? "" : "[READ-ONLY] ";
}

/**
 * Push to K's phone: Web Push to the installed app (Approve / Reject act straight from the notification),
 * and ntfy as a fallback when configured.
 */
export async function push(
  env: Env,
  title: string,
  body: string,
  links?: { approve: string; reject: string },
  tag?: string,
) {
  const fullTitle = envPrefix(env) + title;
  const delivered = await sendToAll(env, { title: fullTitle, body, tag, approveUrl: links?.approve, rejectUrl: links?.reject });
  if (delivered) {
    await env.store.kv.set("last_push_at", String(Date.now()));
  }
  if (!env.NTFY_TOPIC) return;
  // Published as JSON, not as Title/Actions headers: titles carry "£" and "→", and Node's fetch (Azure)
  // refuses any header character beyond Latin-1, which failed every price proposal after it was saved.
  const actions = links
    ? [
        { action: "view", label: "Review and approve", url: links.approve },
        { action: "view", label: "Reject", url: links.reject },
      ]
    : undefined;
  try {
    const res = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: env.NTFY_TOPIC, title: fullTitle, message: body, ...(actions ? { actions } : {}) }),
    });
    if (!res.ok) console.warn(`ntfy: HTTP ${res.status}`);
  } catch (e) {
    // The fallback channel failing must not undo or hide what was already saved (the Inbox still has it).
    console.warn(`ntfy: ${e instanceof Error ? e.message : e}`);
  }
}
