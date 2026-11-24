import type { Env } from "./env";
import { log, swallow } from "./log";
import { push } from "./notify";
import { isDown, serviceState } from "./services";
import type { TodoInput } from "./store/todos";

// Watches the app's own runs. The poll and the nightly each leave a time stamp and watch the other; eBay's
// account-deletion notices, which arrive all day whatever the timers do, watch both. A run that stopped, a nightly
// with failed steps, or three failing polls in a row become an Inbox to-do with one notification, resolved when it's
// healthy again. The app being down altogether is watched from outside (.github/workflows/uptime.yml).

export const NIGHTLY_LATE_MS = 26 * 3_600_000;
export const POLL_LATE_MS = 45 * 60_000;
export const POLL_FAILURES = 3;

type RunName = "poll" | "nightly";
const beatKey = (r: RunName) => `monitor:beat:${r}`;

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

async function file(env: Env, code: string, todos: TodoInput[], now: number): Promise<void> {
  const before = new Set((await env.store.todos.list("open")).filter((t) => t.code === code).map((t) => t.id));
  const r = await env.store.todos.sync("monitor", { codes: [code] }, todos, now);
  if (!r.opened) return;
  for (const t of (await env.store.todos.list("open")).filter((x) => x.code === code && !before.has(x.id)))
    await push(env, t.title, t.detail.split("\n")[0], undefined, `monitor-${t.id}`).catch(swallow(env, "push.failed", { detail: code }));
}

const todo = (code: string, title: string, detail: string, fingerprint: string): TodoInput => ({ code, kind: "you", itemId: null, itemTitle: null, subject: code, title, detail, fingerprint });

const runTodo = (r: RunName, last: number): TodoInput =>
  todo(
    `monitor_${r}`,
    r === "poll" ? "The check for offers, messages and sales has stopped" : "The nightly check hasn't run",
    `${r === "poll" ? "New offers, messages and sales aren't being read, so check the eBay app meanwhile." : "Prices, listings and suggestions weren't reviewed."} It last ran ${when(last)}. Restarting the app in the Azure portal usually fixes it; node scripts/logs.mjs production --errors shows why.`,
    String(last),
  );

/** Stamps a run as having happened, whether or not it went well. */
export const beat = (env: Env, r: RunName, now = Date.now()) => env.store.kv.setJson(beatKey(r), { at: now });
export const lastBeat = async (env: Env, r: RunName): Promise<number | null> => (await env.store.kv.getJson<{ at: number }>(beatKey(r)))?.at ?? null;

/** Files a to-do for each run that has stopped, and resolves it once it runs again. Never throws. */
export async function checkHeartbeat(env: Env, watch: RunName[], now = Date.now()): Promise<void> {
  try {
    for (const r of watch) {
      const last = await lastBeat(env, r);
      // Never stamped: a new install, or the first minutes after this was added.
      if (last == null) continue;
      const late = now - last > (r === "poll" ? POLL_LATE_MS : NIGHTLY_LATE_MS);
      if (late) await log(env, "error", `monitor.${r}_stopped`, { detail: `last ran ${when(last)}` });
      await file(env, `monitor_${r}`, late ? [runTodo(r, last)] : [], now);
    }
  } catch (err) {
    await log(env, "error", "monitor.heartbeat_failed", { err });
  }
}

let checkedAt = 0;
/** The outside trigger: at most every 30 minutes, across instances. */
export async function outsideHeartbeat(env: Env, now = Date.now()): Promise<void> {
  if (now - checkedAt < 30 * 60_000) return;
  checkedAt = now;
  try {
    if (!(await env.store.jobs.acquireLock("heartbeat", 1800))) return;
  } catch (err) {
    await log(env, "warn", "monitor.lock", { err });
    return;
  }
  await checkHeartbeat(env, ["poll", "nightly"], now);
}

/** For tests. */
export const resetOutside = () => void (checkedAt = 0);

/** After each poll: three failing in a row is told to K once, unless a service alert already says why. Never throws. */
export async function notePoll(env: Env, errors: string[], now = Date.now()): Promise<void> {
  try {
    await beat(env, "poll", now);
    const key = "monitor:poll_failures";
    const was = (await env.store.kv.getJson<{ n: number; since: number }>(key)) ?? { n: 0, since: now };
    if (errors.length) await log(env, "error", "poll.failed", { job: "poll", detail: errors.slice(0, 5).join(" | ") });
    const st = errors.length ? { n: was.n + 1, since: was.n ? was.since : now } : { n: 0, since: now };
    if (st.n !== was.n) await env.store.kv.setJson(key, st);
    // Healthy before and after: nothing to open or resolve, so no reads.
    if (!was.n && !st.n) return;
    const told = isDown(await serviceState(env, "ebay_account")) || isDown(await serviceState(env, "ebay"));
    const bad = st.n >= POLL_FAILURES && !told;
    await file(
      env,
      "monitor_poll_errors",
      bad
        ? [todo("monitor_poll_errors", "Reading offers, messages or sales keeps failing", `Failing since ${when(st.since)}. Check the eBay app for offers meanwhile. node scripts/logs.mjs production --errors shows the details.`, String(st.since))]
        : [],
      now,
    );
  } catch (err) {
    await log(env, "error", "monitor.poll_failed", { err });
  }
}

/** After the nightly: each step is logged, and one to-do names those that failed. Never throws. */
export async function noteNightly(env: Env, steps: Record<string, string>, now = Date.now()): Promise<void> {
  try {
    await beat(env, "nightly", now);
    // Sandbox has no traffic data: that step always fails there.
    const failed = Object.entries(steps).filter(([name, r]) => r.startsWith("failed:") && !(name === "traffic" && env.EBAY_ENV !== "production"));
    for (const [name, r] of Object.entries(steps))
      await log(env, failed.some(([n]) => n === name) ? "error" : "info", "nightly.step", { job: "nightly", detail: `${name}: ${r}` });
    const names = failed.map(([n]) => n.replace(/_/g, " ")).sort();
    const told = isDown(await serviceState(env, "ebay_account"));
    await file(
      env,
      "monitor_nightly_steps",
      names.length && !told
        ? [
            todo(
              "monitor_nightly_steps",
              "Part of the nightly check failed",
              `${names.length === 1 ? "This part" : "These parts"} didn't finish: ${names.join(", ")}. The rest ran. It tries again tomorrow night; node scripts/logs.mjs production --errors shows why.`,
              names.join("|"),
            ),
          ]
        : [],
      now,
    );
  } catch (err) {
    await log(env, "error", "monitor.nightly_failed", { err });
  }
}

export interface LastRuns {
  poll: number | null;
  nightly: number | null;
  failedSteps: string[];
  problems: { at: number; level: string; event: string; detail: string | null }[];
}

/** For Settings (owner only): when things last ran, and the last week's warnings and errors, already redacted. */
export async function lastRuns(env: Env, now = Date.now()): Promise<LastRuns> {
  const nightly = await env.store.kv.getJson<{ at: number; steps: Record<string, string> }>("last_nightly");
  const events = await env.store.jobs.recentEvents({ since: now - 7 * 86_400_000, status: ["warn", "error"], limit: 20 });
  return {
    poll: await lastBeat(env, "poll"),
    nightly: (await lastBeat(env, "nightly")) ?? nightly?.at ?? null,
    failedSteps: Object.entries(nightly?.steps ?? {}).filter(([, r]) => r.startsWith("failed:")).map(([n]) => n),
    problems: events.map((e) => ({ at: e.created_at, level: e.status, event: e.kind, detail: e.detail })),
  };
}
