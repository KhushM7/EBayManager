# The custom connectors

Two connectors, two keys, so each can do only its own job.

| File | Key | Can |
| --- | --- | --- |
| `ebaymanager-readonly.swagger.json` | `RO_API_KEY` | Read listings, sales, suggested changes and their outcomes, pricing, health flags, Claude spend and the digest. Nothing else. |
| `ebaymanager-intake.swagger.json` | `INTAKE_API_KEY` | Make a new-listing draft from a Stock Room item. Nothing else. |

Both are OpenAPI 2.0 (the version custom connectors import). `test/readonly.test.ts` checks the read-only file
lists exactly the routes the app serves.

## Import (once per connector)

1. Pick the developer environment (top right, **Environments**), not "Default Directory (default)".
   Then in Power Automate's left menu: **More** → **Discover all** → under **Data**, **Custom connectors** (the
   pin icon keeps it in the menu). There is no Data tab in the menu itself any more. Then **New custom
   connector** → **Import an OpenAPI file**, and pick the file.
2. **General**: the host is Sandbox's. For the real account change it to `ebay-autopilot-production-wrpoyt.azurewebsites.net`. Keep the base URL (`/api/ro` or `/api/intake`).
3. **Security**: API Key, parameter label `API key`, parameter name `X-Api-Key`, location **Header**. (The file already says this; check it.)
4. **Create connector**, then **Test** → **New connection** → paste the key → run `GetStatus` (read-only) and expect `"read_only": true`.

Custom connectors are a premium feature: the free Power Apps Developer Plan covers them in a developer environment.

## Regenerate

The files were written once by hand-run script and are kept as they are. When a route is added in
`src/ro/handler.ts`, add its path here too: the test fails until the two match.
