// One environment: storage (Functions host, deployment package, jobs queue, photos), Key Vault for secrets,
// Application Insights, and the Function App on Flex Consumption (Node 22, 512 MB).
// Security settings (docs/security.md): HTTPS only, TLS 1.2+, no FTP, no basic-auth publishing, the
// Functions host's admin endpoints disabled, no CORS (everything is same-origin), no shared-key access to
// storage, and every secret a Key Vault reference read with the app's own identity.

param env string
param location string
param suffix string
param writeMode string
param ownerObjectId string
param sandboxConveniences bool
param cosmosEndpoint string
param cosmosDatabase string

var appName = 'ebay-autopilot-${env}-${suffix}'
var storageName = toLower('stebay${take(env, 4)}${suffix}')
var vaultName = 'kv-ebay-${take(env, 4)}-${suffix}'
var publicUrl = 'https://${appName}.azurewebsites.net'

// Secrets (Key Vault secret name -> app setting). A secret that isn't uploaded yet is ignored by the app
// (src/platform/azure/env.ts treats an unresolved reference as unset).
var secrets = [
  'EBAY_APP_ID'
  'EBAY_CERT_ID'
  'EBAY_DEV_ID'
  'EBAY_RUNAME'
  'EBAY_COMPS_APP_ID'
  'EBAY_COMPS_CERT_ID'
  'DASHBOARD_KEY'
  'VAPID_KEY'
  'ANTHROPIC_API_KEY'
  'EBAY_DELETION_TOKEN'
  'TRAWL_API_KEY'
  'COMPSAPI_KEY'
  'TRAWL_API_KEY_2'
  'COMPSAPI_KEY_2'
  'PARCEL2GO_CLIENT_ID'
  'PARCEL2GO_CLIENT_SECRET'
  'MCP_TOKEN'
  'SIGNING_KEY'
  'NTFY_TOPIC'
  'PEOPLE'
  'SIGNIN_PATH'
  'IMAGEAI_URL'
  'IMAGEAI_KEY'
]

var roles = {
  blobOwner: 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
  queueContributor: '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
  tableContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
  kvSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  kvSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  monitoringPublisher: '3913510d-42f4-4e42-8a64-420c390055eb'
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
  }
}

resource blob 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource deployments 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob
  name: 'deployments'
  properties: { publicAccess: 'None' }
}

resource photos 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob
  name: 'photos'
  properties: { publicAccess: 'None' }
}

resource queues 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource jobsQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queues
  name: 'jobs'
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-ebay-${env}-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    // A hard daily ingestion cap keeps logging inside the free allowance.
    workspaceCapping: { dailyQuotaGb: json('0.15') }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-ebay-${env}-${suffix}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    DisableLocalAuth: true
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: 'plan-ebay-${env}-${suffix}'
  location: location
  kind: 'functionapp'
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  properties: { reserved: true }
}

resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: appName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientCertEnabled: false
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}deployments'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      scaleAndConcurrency: { maximumInstanceCount: 40, instanceMemoryMB: 512 }
      runtime: { name: 'node', version: '22' }
    }
    siteConfig: {
      // The Functions host's /admin endpoints are switched off. Bicep's type library doesn't list this
      // property yet (BCP089), but ARM passes it through to the site's web config; check-production.mjs
      // and the M4 checks confirm /admin/host/status is closed on the deployed app.
      #disable-next-line BCP089
      functionsRuntimeAdminIsolationEnabled: true
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      cors: { allowedOrigins: [] }
      appSettings: concat(
        [
          { name: 'AzureWebJobsStorage__accountName', value: storage.name }
          { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
          { name: 'JobsQueue__queueServiceUri', value: storage.properties.primaryEndpoints.queue }
          { name: 'JobsQueue__credential', value: 'managedidentity' }
          { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
          { name: 'APPLICATIONINSIGHTS_AUTHENTICATION_STRING', value: 'Authorization=AAD' }
          { name: 'EBAY_ENV', value: env }
          { name: 'WRITE_MODE', value: writeMode }
          { name: 'EBAY_MARKETPLACE', value: 'EBAY_GB' }
          { name: 'EBAY_SITE_ID', value: '3' }
          { name: 'PUBLIC_URL', value: publicUrl }
          { name: 'COSMOS_ENDPOINT', value: cosmosEndpoint }
          { name: 'COSMOS_DATABASE', value: cosmosDatabase }
          { name: 'ALLOW_KEY_LOGIN', value: sandboxConveniences ? 'true' : 'false' }
          { name: 'MCP_ENABLED', value: sandboxConveniences ? 'true' : 'false' }
        ],
        map(secrets, s => { name: s, value: '@Microsoft.KeyVault(VaultName=${vaultName};SecretName=${replace(s, '_', '-')})' })
      )
    }
  }
}

// No FTP or basic-auth (SCM) publishing: deployments sign in with Entra ID.
resource ftp 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: site
  name: 'ftp'
  properties: { allow: false }
}

resource scm 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: site
  name: 'scm'
  properties: { allow: false }
}

// --- Roles for the app's identity (its own resources only) and for the owner ---

resource appBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, site.id, roles.blobOwner)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.blobOwner), principalId: site.identity.principalId, principalType: 'ServicePrincipal' }
}

resource appQueue 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, site.id, roles.queueContributor)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.queueContributor), principalId: site.identity.principalId, principalType: 'ServicePrincipal' }
}

resource appTable 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, site.id, roles.tableContributor)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.tableContributor), principalId: site.identity.principalId, principalType: 'ServicePrincipal' }
}

resource appSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, site.id, roles.kvSecretsUser)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.kvSecretsUser), principalId: site.identity.principalId, principalType: 'ServicePrincipal' }
}

resource appMonitoring 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: insights
  name: guid(insights.id, site.id, roles.monitoringPublisher)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.monitoringPublisher), principalId: site.identity.principalId, principalType: 'ServicePrincipal' }
}

// The owner uploads secrets (scripts/azure-secrets.mjs) and deploys the package.
resource ownerSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, ownerObjectId, roles.kvSecretsOfficer)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.kvSecretsOfficer), principalId: ownerObjectId, principalType: 'User' }
}

resource ownerBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, ownerObjectId, roles.blobOwner)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.blobOwner), principalId: ownerObjectId, principalType: 'User' }
}

output functionAppName string = site.name
output publicUrl string = publicUrl
output keyVaultName string = vault.name
output storageAccountName string = storage.name
output principalId string = site.identity.principalId
