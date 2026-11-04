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
  const headers: Record<string, string> = { Title: fullTitle };
  if (links) headers.Actions = `view, Review and approve, ${links.approve}; view, Reject, ${links.reject}`;
  await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: "POST", headers, body });
}
