import type { Env } from "../env";
import { proposalsTable, salesTable, spendTable, waitingTable } from "./tables";

// The weekly digest (docs/power-platform.md, Phase 2): what sold, what's waiting, and what was suggested and
// why, in plain English. Built from the read-only tables, so it holds no buyer details. Power Automate sends
// it as an email; nothing in it can decide anything.

const DAY = 86_400_000;
const gbp = (n: number) => `£${n.toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function weeklyDigest(env: Env, days = 7, now = Date.now()) {
  const since = now - days * DAY;
  const sales = await salesTable(env, since);
  const waiting = await waitingTable(env, now);
  const proposals = await proposalsTable(env, since);
  const spend = (await spendTable(env, since)).reduce((t, r) => t + r.cost_usd, 0);

  const sold = sales.map((s) => ({ title: s.title, quantity: s.quantity, total: s.line_total, days_to_sell: s.days_to_sell }));
  const revenue = sales.reduce((t, s) => t + (s.line_total ?? 0), 0);
  // Replies and offer answers carry no reason here (they're about a buyer's message), so they're only counted.
  const suggested = proposals.filter((p) => p.reason).map((p) => ({ what: p.kind_label, item: p.item_title, why: p.reason!, outcome: p.outcome }));
  const counts = { suggested: proposals.length, approved: 0, rejected: 0, expired: 0, waiting: 0 };
  for (const p of proposals) if (p.outcome in counts) counts[p.outcome as "approved"]++;

  const lines: string[] = [];
  lines.push(`Your eBay shop, the last ${days} days`);
  lines.push("");
  lines.push(sold.length ? `Sold: ${plural(sold.length, "item")} for ${gbp(revenue)}.` : "Sold: nothing this time.");
  for (const s of sold.slice(0, 15)) lines.push(`  - ${s.title}${s.quantity > 1 ? ` (x${s.quantity})` : ""}${s.total != null ? `, ${gbp(s.total)}` : ""}${s.days_to_sell != null ? `, after ${Math.round(s.days_to_sell)} days` : ""}`);
  lines.push("");
  lines.push(waiting.length ? `Waiting for a decision: ${plural(waiting.length, "change")}. Nothing changes on eBay until someone approves it in the app.` : "Waiting for a decision: nothing.");
  for (const w of waiting.slice(0, 15)) lines.push(`  - ${w.kind_label}${w.item_title ? `: ${w.item_title}` : ""} (for ${w.for === "owner" ? "the owner" : w.for}, ${w.hours_left < 48 ? `expires in ${Math.max(1, Math.round(w.hours_left))} hours` : `${Math.round(w.hours_left / 24)} days left`})`);
  lines.push("");
  lines.push(`Suggested this time: ${plural(counts.suggested, "change")} (${counts.approved} approved, ${counts.rejected} rejected, ${counts.expired} expired, ${counts.waiting} still waiting).`);
  for (const s of suggested.slice(0, 8)) lines.push(`  - ${s.what}${s.item ? ` for ${s.item}` : ""}: ${s.why}`);
  lines.push("");
  lines.push(`Claude cost: $${spend.toFixed(2)}.`);
  const text = lines.join("\n");

  const li = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : "");
  const html =
    `<h2>Your eBay shop, the last ${days} days</h2>` +
    `<p><strong>${esc(lines[2])}</strong></p>` +
    li(sold.slice(0, 15).map((s) => `${esc(s.title)}${s.quantity > 1 ? ` (x${s.quantity})` : ""}${s.total != null ? `, ${gbp(s.total)}` : ""}`)) +
    `<p><strong>${esc(waiting.length ? `Waiting for a decision: ${plural(waiting.length, "change")}.` : "Waiting for a decision: nothing.")}</strong>${waiting.length ? " Nothing changes on eBay until someone approves it in the app." : ""}</p>` +
    li(waiting.slice(0, 15).map((w) => `${esc(w.kind_label)}${w.item_title ? `: ${esc(w.item_title)}` : ""} (for ${esc(w.for === "owner" ? "the owner" : w.for)})`)) +
    (waiting.length ? `<p><a href="${esc(env.PUBLIC_URL)}/">Open the app to decide</a></p>` : "") +
    `<p><strong>Suggested this time: ${plural(counts.suggested, "change")}</strong> (${counts.approved} approved, ${counts.rejected} rejected, ${counts.expired} expired, ${counts.waiting} still waiting).</p>` +
    li(suggested.slice(0, 8).map((s) => `<strong>${esc(s.what)}${s.item ? ` for ${esc(s.item)}` : ""}:</strong> ${esc(s.why)}`)) +
    `<p>Claude cost: $${spend.toFixed(2)}.</p>`;

  return {
    from: new Date(since).toISOString(),
    to: new Date(now).toISOString(),
    days,
    sold: { count: sold.length, revenue: Math.round(revenue * 100) / 100, items: sold },
    waiting: waiting.map((w) => ({ id: w.id, kind_label: w.kind_label, item_title: w.item_title, for: w.for, hours_waiting: w.hours_waiting, hours_left: w.hours_left, open_url: w.open_url })),
    suggestions: { ...counts, examples: suggested.slice(0, 8) },
    claude_cost_usd: Math.round(spend * 100) / 100,
    subject: `eBay shop: ${plural(sold.length, "sale")}, ${waiting.length} waiting for a decision`,
    text,
    html,
  };
}
