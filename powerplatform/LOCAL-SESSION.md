# Running the Power Platform plan in a local Claude session

The cloud session can't reach K's Windows computer, so the steps that need Power BI Desktop and a browser signed in
to Power Platform run in a **local** session: Claude Code in the Claude desktop app on Windows, opened on
`C:\Users\khush\OneDrive\Coding\EbayManager`, with computer use and Claude in Chrome (or the built-in browser) turned
on. Paste the prompt below as the first message.

Before starting:

1. `git checkout power-platform` and `git pull`.
2. `npm install` (needed for `npm run typecheck && npm test`).
3. In Chrome, sign in to make.powerautomate.com with the **work account** (`k@…onmicrosoft.com`) and pick the
   developer environment, so the session doesn't have to.
4. Close any open copy of the Shop Health report in Power BI Desktop.

---

## The prompt

Continue the Microsoft Power Platform plan for EBayManager on this Windows computer. Use computer use for Power BI
Desktop, the browser for Power Automate, Power Apps and Copilot Studio, and edit files in this repository. Work
efficiently and give me a short progress update after each step.

**Read first:** `CLAUDE.md`, `docs/power-platform.md` (design, rules, phase table), `powerplatform/README.md`, and
the README of each folder before its step.

**Where things stand**
- Branch `power-platform`. Don't merge it or open a pull request unless I ask.
- The app's side is built, tested and on for **Sandbox only**: the read-only API (`/api/ro/*`, key `RO_API_KEY`,
  header `X-Api-Key`) and Stock Room intake (`/api/intake/drafts`, key `INTAKE_API_KEY`). Both keys are in
  `.dev.vars`. Never print, paste into chat or commit a key. To use one, copy it to the clipboard:
  `(Select-String .dev.vars -Pattern '^RO_API_KEY=(.+)$').Matches[0].Groups[1].Value | Set-Clipboard`.
- Power Platform: my **work account** in my own Entra directory, free Power Apps Developer Plan, the developer
  environment (not "Default Directory (default)"). My @outlook.com account can't sign in to Power Platform.
- Phase 0 done: the read-only custom connector is imported and `GetStatus` returned `read_only: true`. The intake
  connector may not be imported yet (`powerplatform/connector/README.md`; don't run its test, it makes a real draft).
- Phase 1: the report is generated as a Power BI Project, `powerplatform/powerbi/pbip/ShopHealth.pbip` (model and all
  five pages, checked against Microsoft's schemas). Opening it worked; it then failed only because `ApiKey` was empty.

**Steps, in order**
1. **Power BI.** Run `powershell -ExecutionPolicy Bypass -File scripts\powerbi-open.ps1`. It copies the project to
   `..\EbayManagerPowerPlatform\ShopHealth`, fills in the key from `.dev.vars` and opens it. Refresh. If a sign-in
   prompt appears, choose Anonymous at the address's root. Check each of the five pages for visuals with errors
   (empty visuals are expected: Sandbox has little data). Fix any error in `powerplatform/powerbi/report/report.mjs` or
   `build.mjs`, never only in the copy. Then run `node powerplatform/powerbi/build.mjs`, run
   `python -I powerplatform/powerbi/validate.py <json-schemas clone>` (see the top of `validate.py`), and run the
   script again. Save the copy. `..\EbayManagerPowerPlatform\dashboard.pbix` can then be deleted.
2. **Power Automate** (`powerplatform/flows/README.md`): weekly digest first, then approval nudges, then the Teams
   card. Test each by hand against Sandbox.
3. **Stock Room** (`powerplatform/stockroom/README.md`): Dataverse tables in a `Stock Room` solution, the canvas
   app, and the send-as-draft flow through the intake connector.
4. **Copilot Studio** (`powerplatform/copilot/README.md`): MCP tool at `/api/ro/mcp` with the read-only key in the
   `X-Api-Key` header, then the eight test questions.
5. After each phase, update the phase table in `docs/power-platform.md` and the README guides with anything that
   differed from the recipe, and fix any generator or file that was wrong.

**Rules**
- Nothing in Power Platform may write to eBay, decide a proposal or hold eBay tokens: only the read-only API and the
  drafts-only intake. No buyer personal data.
- Commits: author `Khush Mehta <124626664+KhushM7@users.noreply.github.com>`, unsigned (`-c commit.gpgsign=false`),
  no co-author or session lines, no mention of Claude. Push only to `power-platform`. Run
  `npm run typecheck && npm test` before committing code changes.
- Production stays mine: don't run production scripts or deploy production.
- Ask me before anything that sends email or Teams messages to anyone but me, or that costs money (no paid licences
  or trials).
