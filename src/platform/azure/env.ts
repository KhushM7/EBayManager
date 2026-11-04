import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { join } from "node:path";
import type { Env } from "../../env";
import { makeStore, type Store } from "../../store";
import { CosmosDocStore } from "../../store/cosmos";
import { staticAssets } from "./static";

// Builds the app's Env on Azure Functions (docs/azure-migration.md). Settings come from the Function App's
// app settings; secrets in them are Key Vault references the platform resolves using the app's managed
// identity, so no secret is in code or in the deployment package. The Cosmos DB client signs in with the
// same managed identity (key auth is disabled on the account) and is allowed into this environment's
// database only.

const REQUIRED = ["EBAY_ENV", "WRITE_MODE", "EBAY_MARKETPLACE", "EBAY_SITE_ID", "PUBLIC_URL", "COSMOS_ENDPOINT", "COSMOS_DATABASE"] as const;

let cached: { env: Omit<Env, "enqueue">; store: Store } | null = null;

export function azureEnv(): Omit<Env, "enqueue"> {
  if (cached) return cached.env;
  const v = process.env;
  const missing = REQUIRED.filter((k) => !v[k]);
  if (missing.length) throw new Error(`Missing app settings: ${missing.join(", ")}`);
  if (v.EBAY_ENV !== "sandbox" && v.EBAY_ENV !== "production") throw new Error(`EBAY_ENV must be sandbox or production, not ${v.EBAY_ENV}`);

  const client = new CosmosClient({
    endpoint: v.COSMOS_ENDPOINT!,
    aadCredentials: new DefaultAzureCredential(v.AZURE_CLIENT_ID ? { managedIdentityClientId: v.AZURE_CLIENT_ID } : {}),
    // Throttled requests (429) are retried with the server's suggested wait, up to 30 seconds.
    connectionPolicy: { retryOptions: { maxRetryAttemptCount: 9, fixedRetryIntervalInMilliseconds: 0, maxWaitTimeInSeconds: 30 } },
  });
  const store = makeStore(new CosmosDocStore(client, v.COSMOS_DATABASE!));
  // A Key Vault reference the platform couldn't resolve (the secret isn't uploaded yet) arrives as its literal
  // text; it must count as unset, never as a value.
  for (const k of Object.keys(v)) if (String(v[k] ?? "").startsWith("@Microsoft.KeyVault(")) delete v[k];
  const opt = (k: string) => (v[k] ? String(v[k]) : undefined);
  const env: Omit<Env, "enqueue"> = {
    store,
    EBAY_ENV: v.EBAY_ENV!,
    WRITE_MODE: v.WRITE_MODE!,
    EBAY_MARKETPLACE: v.EBAY_MARKETPLACE!,
    EBAY_SITE_ID: v.EBAY_SITE_ID!,
    PUBLIC_URL: v.PUBLIC_URL!,
    EBAY_APP_ID: v.EBAY_APP_ID ?? "",
    EBAY_CERT_ID: v.EBAY_CERT_ID ?? "",
    EBAY_DEV_ID: v.EBAY_DEV_ID ?? "",
    EBAY_RUNAME: v.EBAY_RUNAME ?? "",
    EBAY_COMPS_APP_ID: opt("EBAY_COMPS_APP_ID"),
    EBAY_COMPS_CERT_ID: opt("EBAY_COMPS_CERT_ID"),
    ASSETS: staticAssets(join(__dirname, "web")),
    DASHBOARD_KEY: v.DASHBOARD_KEY ?? "",
    VAPID_KEY: opt("VAPID_KEY"),
    ANTHROPIC_API_KEY: opt("ANTHROPIC_API_KEY"),
    ALLOW_KEY_LOGIN: opt("ALLOW_KEY_LOGIN"),
    MCP_ENABLED: opt("MCP_ENABLED"),
    EBAY_DELETION_TOKEN: opt("EBAY_DELETION_TOKEN"),
    TRAWL_API_KEY: opt("TRAWL_API_KEY"),
    COMPSAPI_KEY: opt("COMPSAPI_KEY"),
    MCP_TOKEN: v.MCP_TOKEN ?? "",
    SIGNING_KEY: v.SIGNING_KEY ?? "",
    NTFY_TOPIC: v.NTFY_TOPIC ?? "",
  };
  // Never in production, whatever the settings say (also refused in code where each is used).
  if (env.EBAY_ENV === "production" && (env.ALLOW_KEY_LOGIN === "true" || env.MCP_ENABLED === "true"))
    throw new Error("ALLOW_KEY_LOGIN and MCP_ENABLED must be off in production");
  if (!env.SIGNING_KEY) throw new Error("SIGNING_KEY is not set");
  cached = { env, store };
  return env;
}
