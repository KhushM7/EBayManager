# Safety and environments

Nothing touches K's real eBay seller account until Phase 6, and nothing changes it until Phase 7. Before then, every feature is built and tested on eBay Sandbox. When the real account is first connected, it is read-only.

Decided 2026-11-02. See [roadmap.md](roadmap.md) for the phases and [approvals.md](approvals.md) for what needs approval.

## Three stages

| Stage | `EBAY_ENV` | `WRITE_MODE` | Seller account | What can happen on eBay |
| --- | --- | --- | --- | --- |
| 1. Sandbox | `sandbox` | `approval` | eBay Sandbox test user | Approved writes to fake sandbox listings |
| 2. Production read-only | `production` | `off` | K's real account | Reads only. Proposals are created as a dry run and cannot be applied |
| 3. Production | `production` | `approval` | K's real account | Approved writes only |

### Gates between stages

**Sandbox → production read-only.** All of these must be true:

- Every feature planned so far works end to end on Sandbox: approval from the phone, Claude audit, metrics, buyer messages.
- The write-gate tests pass (see below).
- The production keyset is active. eBay requires either a marketplace account deletion notification endpoint or an opt-out exemption, and this app can opt out because it stores no other users' data.
- K says go.

**Production read-only → production.** K ticks every item on the [go-live checklist](#go-live-checklist).

## Configuration

Two Worker variables control the environment. Each stage is a separate wrangler environment with its own D1 database and R2 bucket, so sandbox data and real data never mix.

```toml
[env.sandbox]
vars = { EBAY_ENV = "sandbox", WRITE_MODE = "approval" }
# own D1 database and R2 bucket

[env.production]
vars = { EBAY_ENV = "production", WRITE_MODE = "off" }   # flipped to "approval" at Phase 7
# own D1 database and R2 bucket
```

`EBAY_ENV` selects the hosts and the keyset:

| | Sandbox | Production |
| --- | --- | --- |
| OAuth | `auth.sandbox.ebay.com` | `auth.ebay.com` |
| REST APIs and token endpoint | `api.sandbox.ebay.com` | `api.ebay.com` |
| Trading API | `api.sandbox.ebay.com/ws/api.dll` | `api.ebay.com/ws/api.dll` |
| Keyset secrets | sandbox App ID, Cert ID, Dev ID, RuName | production App ID, Cert ID, Dev ID, RuName |

`ebayHosts(env)` in `src/ebay/hosts.ts` is the only place hosts are chosen (a test checks this). An unset or misspelt `EBAY_ENV` throws rather than defaulting to production. The top level of `wrangler.toml` is for local `wrangler dev` only and uses Sandbox.

**Comps exception.** Browse API comps use an application token (client credentials). They read public listings and are not tied to any seller account. Sandbox has almost no realistic listings, so during the sandbox stage comps may use the production keyset's app token: set the optional `EBAY_COMPS_APP_ID` and `EBAY_COMPS_CERT_ID` secrets. This links no account and cannot write anything.

## The write gate

Every eBay call that changes something goes through one function, `ebayWrite()` in `src/ebay/write.ts`. No other module may call an eBay write endpoint.

`ebayWrite(env, proposalId)` reads the proposal from D1 itself, so a caller can't talk it into anything. It refuses, and logs the refusal, unless **all** of these hold:

1. `WRITE_MODE` is `approval`.
2. The kill switch is off.
3. The proposal's status is `approved` and it isn't a dry run. The gate claims it atomically (`approved` → `applying`), so a double tap can't apply it twice. Auto-apply doesn't exist yet; when it does, `LOCKED_KINDS` in `src/rules.ts` can never be auto-applied.
4. The proposal kind has a builder (`price`, `revise` and `create_listing` so far). Other kinds can be approved but wait.

Expiry is checked when K decides: an expired proposal can't be approved, and its signed links stop working.

Every outcome (applied, refused or failed) is written to `audit_log`.

**Second guard.** The Trading client's `trading()` function only sends verbs on a read allowlist (`READ_VERBS` in `src/ebay/trading.ts`). Only `write.ts` may use the lower-level `tradingRequest()`.

Tests enforce all of this (`test/gate.test.ts`, `test/safety.test.ts`):

- Every refusal path: write mode off or unset, kill switch on, pending, rejected, expired, failed, already applied, dry run, a kind without a builder, an expired link.
- Source scans fail if any file other than `src/ebay/write.ts` names an eBay write call, if anything else uses `tradingRequest`, if a new module makes network calls, or if an eBay host appears outside `hosts.ts`.

### Kill switch

The `pause_writes` tool (and, from Phase 2, a **Pause all writes** switch in the dashboard's Settings screen) sets `writes_paused = 1` in the D1 `settings` table. Claude can pause but not resume: K resumes with `npm run writes:resume:sandbox` (or `:production`), and from Phase 2 in Settings. The gate reads that row on every write. Pausing takes effect immediately, with no redeploy. Proposals keep arriving while paused. Ones K approves stay `approved` and are not applied.

### Audit log

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  env TEXT NOT NULL,            -- sandbox | production
  proposal_id TEXT,
  call TEXT NOT NULL,           -- e.g. ReviseFixedPriceItem
  request TEXT NOT NULL,        -- redacted of tokens
  response TEXT,
  outcome TEXT NOT NULL         -- applied | refused | failed
);
```

The dashboard's Activity screen shows this table.

## Production read-only

In the read-only stage, four layers stop writes:

1. **`WRITE_MODE=off`.** The write gate refuses everything. This is the main guard.
2. **Read allowlist.** The Trading client refuses any verb that isn't a read.
3. **Read-only OAuth scopes.** The real account is connected with read-only scopes where eBay offers them: `sell.inventory.readonly`, `sell.marketing.readonly`, `sell.account.readonly`, `sell.fulfillment.readonly` and `sell.analytics.readonly`. eBay itself then rejects REST write calls.
4. **Dry runs.** Proposals created while `WRITE_MODE=off` are stored with `dry_run = 1`, get no approve link, and can never be applied, even after writes are switched on.

**Caveat.** eBay's documentation says the traditional APIs, including the Trading API used for existing listings, don't use OAuth scopes at all. Any valid user token can call them ([Using OAuth with the eBay traditional APIs](https://developer.ebay.com/api-docs/static/oauth-trad-apis.html)). So layer 3 does not cover Trading API writes; layers 1 and 2 do. **Confirmed on Sandbox, 2026-11-02:** with a read-only sign-in (`/oauth/start?readonly=1`, every `sell.*` scope `.readonly`), an approved `ReviseFixedPriceItem` changed a test listing's price from £6.00 to £5.50. Read-only scopes don't protect Trading API listings, so layers 1 and 2 are what keep the real account safe in the read-only stage.

Moving to production writes needs a fresh sign-in with the full scopes. This step is deliberate, so it can't happen by accident.

## Go-live checklist

Replaced on 2026-11-02 by [go-live-tests.md](go-live-tests.md): one nightly read-only cycle plus a full list of remote and hands-on tests. The original list follows for reference.

- [ ] At least 7 days in production read-only with no errors in the nightly run.
- [ ] Listings, prices, watchers and orders on the dashboard match eBay Seller Hub.
- [ ] Dry-run proposals from the Claude audit look sensible. At least 10 have been reviewed.
- [ ] Return and shipping business policies on the real account match `src/rules.ts`.
- [ ] Floor prices are set for any items that need them.
- [ ] Kill switch tested: pause on, try an approval in sandbox and check it is refused, pause off.
- [ ] Push notifications arrive on K's phone, and the Approve button works on a sandbox proposal.
- [ ] The first production writes are applied one at a time and checked on eBay before the next.
