# Running on Cloudflare's free plan: the job queue

K decided on 2026-11-03 to stay on the Workers Free plan. This design gives the same results (same data, same prompts, same checks, same volume) by doing the work in small steps from a queue. Jobs take hours instead of minutes. Nothing may fail because a limit was reached: running out of budget pauses a job until the next step, it never breaks one.

## Why

The first-day audit of 2026-11-03 failed half-way with "Too many subrequests". On the free plan each run (a page request or a cron firing) may make:

| Limit (Free) | Value | Source |
| --- | --- | --- |
| Outgoing calls (fetch: eBay, Claude, Trawl, CompsAPI, Web Push, ntfy) | 50 per run | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| D1 queries | 50 per run; a `db.batch()` counts as one | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Calls to Cloudflare services | 1,000 per run | Workers limits (not defined further) |
| CPU time | 10 ms per run, with "some built-in flexibility" for occasional overruns; error 1102 when exceeded | Workers limits |
| Wall time | none for page requests while connected; 15 min for cron | Workers limits |
| Simultaneous outgoing connections | 6 per run | Workers limits |
| Requests | 100,000 a day (cron firings count) | Workers limits |
| Cron triggers | 5 per account | Workers limits |
| D1 storage | 500 MB per database; rows 5 million read and 100,000 written a day (as Durable Objects, which "match D1 pricing") | D1 and DO pages |

Waiting for eBay, Claude or the database doesn't count as CPU. Only the app's own work does: parsing eBay's XML, the pricing maths, encrypting push notifications.

## Alternatives checked (2026-11-03)

- **Workers Paid** ($5 a month) removes the problem. K declined: too expensive for a small seller account.
- **Student offers.** The GitHub Student Developer Pack has no Cloudflare credit (its cloud offers are Azure $100, Heroku $13 a month for 24 months, MongoDB Atlas $50). Cloudflare has no student program. Azure for Students gives $100 for 12 months with no card, but moving there means rewriting the app around Azure Functions and a different database, and the credit expires. Oracle's and Google's free tiers couldn't be checked (their pages didn't load) and would also mean a rewrite. Not worth it.
- **Cloudflare Workflows** (free: 3,000 steps a day, 10 ms CPU per step) would give durable steps with built-in retries, but its docs don't say whether each step gets its own 50-call budget, completed runs are kept only 3 days, and its state isn't visible to the app. Not chosen; worth revisiting if its per-step budget is documented.
- **Cloudflare Queues** (free: 10,000 operations a day, messages kept 24 hours) would trigger work push-style, but each consumer run has the same limits, and a D1 table does the same job while staying visible in the app and testable with the existing fake D1. Not chosen.

## The design

### 1. One job table, one worker per minute

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- price_gather | price_decide | specs_turn | review_turn | nightly_step | audit_step | poll | draft_reply | apply | ...
  parent TEXT,                   -- the job this belongs to (a nightly run, an audit, a listing review)
  item_id TEXT,
  priority INTEGER NOT NULL,     -- 0 approvals and sends, 1 buyer messages, 2 K's requests from the app, 3 nightly, 4 audit
  status TEXT NOT NULL,          -- queued | running | done | failed | cancelled
  not_before INTEGER NOT NULL,   -- earliest start (backoff, rate limits, "after this other job")
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,           -- a running job whose lease passed is treated as crashed
  state TEXT NOT NULL,           -- the job's checkpoint (inputs, results so far, a Claude conversation)
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE job_runs (          -- one row per step run: what it used, for tuning and for the Metrics screen
  job_id TEXT, at INTEGER, outcome TEXT, external_calls INTEGER, db_queries INTEGER, note TEXT
);
```

Cron triggers (3 of the 5 allowed):
- `* * * * *` **runner**: claims the next job and runs one step. 1,440 runs a day, 1.4% of the daily request allowance.
- `0 2 * * *` **nightly**: queues the nightly run's first step (it no longer does the work itself).
- `*/15 * * * *` **poll**: queues a buyer-message poll.

The runner claims a job atomically (`UPDATE jobs SET status='running', lease_until=? WHERE id=(SELECT id FROM jobs WHERE status='queued' AND not_before<=? ORDER BY priority, created_at LIMIT 1) AND status='queued'`), so two overlapping runs can't take the same job. One heavy job runs at a time: a lock row with an expiry keeps it to one, which also keeps the app far inside eBay's, Anthropic's and the data providers' rate limits.

### 2. A budget on every run, enforced in code

A `Budget` object travels with each run and counts every outgoing call and every D1 query:
- **Outgoing calls** go through one counted `fetch` (`src/net.ts`). The eBay, sold-data, push and ntfy clients use it, and the Anthropic SDK is given it as its `fetch` option. A source-scan test (like the existing ones in `safety.test.ts`) fails if any module calls `fetch` directly.
- **D1** is wrapped in a counting proxy: `first`, `all`, `run` and `batch` each count one.
- **Limits used:** 40 outgoing calls and 40 D1 queries per run, a reserve of 10 below each hard limit. The docs don't say for certain whether D1 queries share the 50 with outgoing calls, so the runner also stops at 45 for both combined until the first week's `job_runs` numbers show which is true.
- **Before every call** the budget checks there's room for it and for the step's checkpoint write. If not, it throws `OutOfBudget`. That's not an error: the step saves its checkpoint, the job goes back to `queued`, and it carries on in the next minute.
- **Connections** run one at a time (no parallel tool calls inside a run), well under the 6-connection limit.

### 3. Every job is split into steps that fit

Each step does a bounded amount of work, saves a checkpoint in `state`, and either finishes or queues the next step. Worst cases per step:

| Step | Outgoing calls | D1 queries |
| --- | --- | --- |
| Read one listing (GetItem) | 1–2 (token refresh) | 3 |
| One sold-data search (cache first; Trawl or CompsAPI) | 0–1 | 3 |
| eBay active listings for one search (Browse) | 1–2 | 2 |
| Identify or match titles with Claude (one call, up to 100 titles) | 1 | 2 |
| Pricing maths and decision (no network) | 0 | 4 |
| One Claude turn of a listing review or spec lookup, with its tool results from stored data | 1 | 5 |
| A tool that needs eBay mid-review (get_listing on a fresh item) | 1–2 | 3 |
| Draft one buyer reply (listing context + Claude) | 2–3 | 4 |
| Poll questions and offers (queues a draft job per new one) | 2–3 | 4 + 1 per new message |
| Apply one approved proposal (lock check, write, audit, refresh snapshot) | 3–5 | 6 |
| Send one push notification (per device) | 1 per device | 2 |

A listing's price check becomes: identify, then one gather step per search and provider (sold searches from the 30-day cache cost no calls), then matching in batches, then the decision. That's around 8 to 12 steps instead of one run. A bundle simply has more gather steps, so bundles are priced in full and nothing is cut.

The Claude listing review keeps the same model, prompt and tools. Its conversation is saved in `state` after each turn, append-only (thinking blocks included, as preserved thinking requires), and each run sends one turn. Its heavy inputs are prepared first as their own jobs: the price check and the published-spec lookup. So `price_check` and `get_listing` answer from stored results, and a turn never runs out of room half-way through a tool.

### 4. CPU: staying under 10 ms

- **Parsing:** big eBay XML replies are parsed in a step of their own, and only the fields used are stored.
- **The pricing maths:** this runs on its own, with no network work in the same run. Its heaviest part (Theil–Sen over all pairs of sales) is split across steps when there are more than 150 sales: the pairs are processed in chunks and the partial results checkpointed, so the answer is identical.
- **Push encryption:** one device per step.
- **Measured:** Workers Logs (on the free plan) record the CPU time of each run. The runner logs the job kind with each run, and a weekly check lists any kind near 8 ms so it can be split further.
- **If 10 ms is still exceeded:** Cloudflare ends the run with error 1102, which no code can catch. The job's lease then expires and it's retried (see 5). A step that fails this way twice is split in code; it's never retried for ever.

### 5. Errors, retries and nothing lost

- **Crashes and CPU kills:** a `running` job whose lease (5 minutes) has passed goes back to `queued` with `attempts + 1`.
- **Temporary failures** (network, 5xx, 429, Claude overloaded): retried with backoff (`not_before` = now + 1, 4, 15, 60 minutes, or the `Retry-After` header). A rate limit doesn't count as an attempt.
- **Permanent failures** (bad request, eBay refusal, a rule refusing): the job fails straight away with the reason, and the parent job carries on without it, as the nightly steps do today.
- **After 6 attempts** a job is `failed`, shown on the Background work card (8), and you get a push saying which job failed and why. There's a Retry button.
- **No double effects:** every step is safe to run twice.
  - A proposal is created with the job's id as its key (`INSERT OR IGNORE`), so a rerun can't file it twice or notify twice.
  - The write gate already claims proposals atomically.
  - Sold-data usage is counted before the call, so a crash can't spend a search twice uncounted.
  - Searches and identifications are cached, so a rerun costs nothing new.
- **Stale work:** a job queued for something that has changed since (the listing ended, the offer expired, the proposal was decided) checks first and finishes as "no longer needed".

### 6. Daily allowances guarded too

A `usage_daily` row counts runs, D1 rows written, Claude spend (the existing budget) and sold-data searches (the existing monthly caps):
- At 70% of any free daily allowance, priorities 3 and 4 (the nightly and the audit) wait until 00:00 UTC. Approvals, replies, offers and K's own requests carry on.
- At 90%, only approvals and sends run. You get a push saying so.
- Expected use is far below these lines: about 1,500 runs and a few thousand rows a day against 100,000 of each.

### 7. Things you trigger from the app

- **Run the audit, "Propose fixes", Check price:** these add a job and answer at once ("Queued: about 40 minutes"). The page shows progress from the job table, and a push says when it's done.
- **Approve and reject:** one decision runs straight away in the request, which fits (3–5 calls). A batch approval applies the first few in the request and queues the rest at the top priority (0), so a 20-label batch can't break the limit. The label says "Approved, sending" until each one is applied.
- **Pause all changes:** it still works instantly. Queued `apply` jobs check the kill switch before they run, as the write gate already does.

### 8. What you see

A **Background work** card on Metrics (and a line on each screen that's waiting for a job) shows:
- what's queued and running, with the oldest waiting time;
- each job's progress, for example "Audit: 18 of 41 steps";
- failed jobs, with their reasons and a Retry button;
- the last 7 days of `job_runs`, including the highest calls used in a single run, so tightening limits show up early.

The nightly push summary arrives when its last step finishes, not at 02:00.

### 9. How long things take

| Job | Steps (4 listings) | Time |
| --- | --- | --- |
| Buyer question to draft | 2–3 | 1–3 minutes (top priority) |
| Approval of one label | 1 | immediate |
| Price check of one listing | 8–12 | 10–15 minutes |
| Listing review with fixes | 15–25 | 20–30 minutes |
| Nightly run | about 60–90 | 1–2 hours |
| First-day audit (all of it, with specs) | about 80–120 | 1.5–2.5 hours |

Prompt caching lasts 5 minutes. The runner keeps a conversation's turns in consecutive minutes so its cache stays warm. The added Claude cost is a few cents a month at most.

### 10. Proving it before go-live

- **Tests:** every step kind runs against recorded eBay, Claude and provider replies (the existing fakes), and must stay within 40 calls and 40 queries in the worst case, including a 3-part bundle and a 300-sale price history.
- **Runner tests:** claims are atomic, leases expire, backoff works, failures are final after 6 attempts, a rerun files no duplicate, and the kill switch stops `apply` jobs.
- **Safety scans:** no direct `fetch` outside `src/net.ts`; no D1 use outside the counting proxy.
- **On Sandbox:** a full nightly and a full audit run through the queue, and `job_runs` shows the peak per run.
- **On production:** one read-only nightly cycle. This is already the Phase 7 exit gate.

## Build order

1. `src/net.ts` (counted fetch), the D1 counting proxy, `Budget` and `OutOfBudget`, with their tests and the safety scans.
2. The jobs table, the runner, leases, retries, the daily allowance guard, and the Background work card.
3. Pricing as steps (gather, match, decide, recording the decision).
4. Resumable Claude runs: the listing review, the spec lookup, nightly triage and bundle advice.
5. The nightly and the audit as job chains; the poll and drafts as jobs; queued batch approvals.
6. A full run on Sandbox, then the production deploy and K's one read-only nightly cycle.

Estimated 2 to 3 days of work. Until it ships, the audit should only be run listing by listing, and the nightly may stop part-way (the steps that fail are listed in Metrics).
