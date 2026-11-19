# Microsoft Power Platform pieces

Everything here is built in K's Microsoft 365 tenant, by hand, from these files. Nothing in this folder runs in
the app. The app's side (the read-only API, the nightly export and the Stock Room intake) is in `src/ro/` and
`src/intake.ts`; the design, the rules and K's to-do list are in [docs/power-platform.md](../docs/power-platform.md).

| Folder | What it is | Phase |
| --- | --- | --- |
| `connector/` | The two custom connectors as OpenAPI 2.0 files: `ebaymanager-readonly.swagger.json` (reads only) and `ebaymanager-intake.swagger.json` (makes drafts only) | 0, 3 |
| `powerbi/` | The Shop Health report: a Power BI Project with the model and all five pages (`pbip/`), plus the same model as Power Query, DAX and one TMDL script, and the page-by-page guide | 1 |
| `flows/` | The three Power Automate flows: approval reminders, the weekly digest, and the Teams card | 2 |
| `stockroom/` | The Stock Room canvas app: Dataverse tables, Power Fx, and the flow that sends "sell" items as drafts | 3 |
| `copilot/` | The "Ask the shop" Copilot Studio agent: instructions, tools and test questions | 4 |

Built in K's developer environment against Sandbox so far: both connectors (imported), the Power BI report
(refreshed, five pages checked) and two flows, the weekly digest and approval nudges (2026-11-19). The Teams card,
Stock Room and the agent are still guides; the phase table in
[docs/power-platform.md](../docs/power-platform.md) says what is proven. The app's side is tested (`test/readonly.test.ts`).

To run the remaining steps in a Claude session on K's own computer, see [LOCAL-SESSION.md](LOCAL-SESSION.md).
