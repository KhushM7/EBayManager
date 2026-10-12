import type { Env } from "./env";

/** Push to K's phone via ntfy, with Approve / Reject buttons that open signed links. */
export async function push(env: Env, title: string, body: string, links?: { approve: string; reject: string }) {
  if (!env.NTFY_TOPIC) return;
  const headers: Record<string, string> = { Title: title };
  if (links) headers.Actions = `view, Review and approve, ${links.approve}; view, Reject, ${links.reject}`;
  await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: "POST", headers, body });
}
