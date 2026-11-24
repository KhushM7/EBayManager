// What scripts/backfill-history.mjs would write, worked out from what is stored. Pure, so the test runs it.
// Ids are fixed ("ev:bf:..."), so a second run finds them there and adds nothing. Only facts on the documents are
// used: a reason that wasn't recorded is "unknown".

const ev = (pk, id, e) => ({
  id: `ev:bf:${id}:${e.event}`,
  pk,
  type: "suggestion_event",
  episode: 1,
  actor: null,
  reason_code: null,
  superseded_by: null,
  snapshot: null,
  backfilled: true,
  ...e,
  created_at: e.at,
});

const CLOSED = ["applied", "failed", "rejected", "expired", "agreed"];
const SUPERSEDING = ["price", "revise", "promote"];
const NOTHING_SENT = /: nothing to (end|change|lower)\.$/;

/** Labels: their filing, and how each closed one closed. `known` holds "<suggestion id>:<event>" already recorded. */
export function planProposals(rows, known = new Set()) {
  const events = [];
  const patches = [];
  const add = (p, e) => known.has(`${p.id}:${e.event}`) || events.push(ev(p.pk, p.id, { suggestion_id: p.id, source: "proposal", item_id: p.item_id ?? null, kind: p.kind, ...e }));
  for (const p of rows) {
    add(p, { event: "filed", at: p.created_at });
    if (!CLOSED.includes(p.status)) continue;
    const at = p.decided_at ?? p.created_at;
    if (p.status !== "expired") {
      const reason_code = p.status === "applied" ? (NOTHING_SENT.test(p.result ?? "") ? "nothing_to_do" : null) : p.status === "failed" ? null : "person";
      add(p, { event: p.status, at, actor: p.decided_by ?? null, reason_code });
      continue;
    }
    // Closed the moment a newer label of the same kind was filed: that one replaced it.
    const newer = SUPERSEDING.includes(p.kind) && p.decided_at != null ? rows.find((q) => q.id !== p.id && q.pk === p.pk && q.kind === p.kind && q.created_at === p.decided_at) : null;
    const reason_code = p.closed_reason ?? (newer ? "superseded" : p.decided_at == null ? "unknown" : p.decided_at >= p.expires_at ? "lapsed" : "unknown");
    add(p, { event: "expired", at, reason_code, superseded_by: newer?.id ?? null });
    if (!p.closed_reason && reason_code !== "unknown") patches.push({ id: p.id, pk: p.pk, set: { closed_reason: reason_code, ...(newer ? { superseded_by: newer.id } : {}) } });
  }
  return { events, patches };
}

/** Old words are kept only where the app or K wrote them (as src/store/todos.ts). */
const KEEPS_WORDS = ["audit", "nightly", "listing", "services", "allowance"];

export function planTodos(rows, known = new Set()) {
  const events = [];
  for (const t of rows) {
    if ((t.episode ?? 1) > 1) continue; // Already being recorded live.
    const snapshot = KEEPS_WORDS.includes(t.source) ? { title: t.title, detail: t.detail, note: t.note ?? null, filed_at: t.created_at, item_title: t.item_title ?? null } : null;
    const add = (e) => known.has(`${t.id}:${e.event}`) || events.push(ev(t.pk, t.id, { suggestion_id: t.id, source: "todo", item_id: t.item_id ?? null, kind: t.code, snapshot, ...e }));
    add({ event: "filed", at: t.created_at });
    if (t.status !== "open") add({ event: t.status, at: t.decided_at ?? t.at, actor: t.decided_by ?? null, reason_code: t.status === "resolved" ? (t.closed_reason ?? "unknown") : "person" });
  }
  return { events, patches: [] };
}

export function planAdvice(rows, known = new Set()) {
  const events = [];
  for (const a of rows) {
    if (a.kind === "run") continue;
    const add = (e) => known.has(`${a.id}:${e.event}`) || events.push(ev(a.pk, a.id, { suggestion_id: a.id, source: "advice", item_id: null, kind: "bundle_advice", ...e }));
    add({ event: "filed", at: a.at });
    const at = a.decided_at ?? (a.status === "replaced" ? rows.find((r) => r.kind === "run" && r.at > a.at)?.at : undefined);
    // When a dismissal has no time of its own, its filing time is the only certain one.
    if (a.status === "dismissed") add({ event: "dismissed", at: at ?? a.at, actor: a.decided_by ?? null, reason_code: "person" });
    if (a.status === "replaced") add({ event: "replaced", at: at ?? a.at, reason_code: "replaced_by_run" });
  }
  return { events, patches: [] };
}
