import type { Env } from "./env";

/** [SANDBOX] or [READ-ONLY] on every push, so a test can't be mistaken for the real account. */
export function envPrefix(env: Pick<Env, "EBAY_ENV" | "WRITE_MODE">): string {
  if (env.EBAY_ENV !== "production") return "[SANDBOX] ";
  return env.WRITE_MODE === "approval" ? "" : "[READ-ONLY] ";
}

/** Push to K's phone via ntfy, with Approve / Reject buttons that open signed links. */
export async function push(env: Env, title: string, body: string, links?: { approve: string; reject: string }) {
  if (!env.NTFY_TOPIC) return;
  const headers: Record<string, string> = { Title: envPrefix(env) + title };
  if (links) headers.Actions = `view, Review and approve, ${links.approve}; view, Reject, ${links.reject}`;
  await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: "POST", headers, body });
}
