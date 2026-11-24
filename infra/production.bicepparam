// Production: K's real eBay account. Writes are on in approval mode since go-live (Phase 8, 2026-11-07, after
// the go-live tests): every eBay change still needs K's approval and passes the write gate. No test sign-in,
// no /mcp. Only K deploys this. To go back to read-only, set writeMode = 'off' and redeploy the infrastructure.
using 'main.bicep'

param env = 'production'
param location = readEnvironmentVariable('AZURE_LOCATION', 'francecentral')
param writeMode = 'approval'
// Claude switched off to keep the running cost at nothing (K, 2026-11-24). Delete the line, or set a figure up to 1, to
// turn it back on, then redeploy the infrastructure.
param claudeDailyBudgetUsd = '0'
param ownerObjectId = readEnvironmentVariable('AZURE_OWNER_OBJECT_ID', '')
param sandboxConveniences = false
// The photo AI container (docs/imageai.md): a pinned ghcr.io tag; empty leaves it undeployed.
param imageAiImage = readEnvironmentVariable('IMAGEAI_IMAGE', '')
param imageAiKey = readEnvironmentVariable('IMAGEAI_DEPLOY_KEY', '')
