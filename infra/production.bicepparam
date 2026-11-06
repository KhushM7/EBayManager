// Production: K's real eBay account. Read-only until Phase 8 and the go-live tests: WRITE_MODE stays 'off'
// (main.bicep forces it off for production regardless), no test sign-in, no /mcp. Only K deploys this.
using 'main.bicep'

param env = 'production'
param location = readEnvironmentVariable('AZURE_LOCATION', 'francecentral')
param writeMode = 'off'
param ownerObjectId = readEnvironmentVariable('AZURE_OWNER_OBJECT_ID', '')
param sandboxConveniences = false
