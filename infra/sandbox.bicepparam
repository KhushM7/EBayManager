// Sandbox: eBay's test environment, approved writes, test sign-in and /mcp on. Claude may deploy this.
using 'main.bicep'

param env = 'sandbox'
param location = readEnvironmentVariable('AZURE_LOCATION', 'francecentral')
param writeMode = 'approval'
param ownerObjectId = readEnvironmentVariable('AZURE_OWNER_OBJECT_ID', '')
param sandboxConveniences = true
