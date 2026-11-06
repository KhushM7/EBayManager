// EBayManager on Azure (docs/azure-migration.md). One template, one environment per deployment:
//   az deployment sub create --location <region> --template-file infra/main.bicep --parameters infra/<env>.bicepparam
// Creates the environment's resource group (Function App on Flex Consumption, storage with the jobs queue and
// the photos container, Key Vault, Application Insights) and, in the shared resource group, the one Cosmos DB
// free-tier account with this environment's database. Sandbox and production share nothing but that account,
// and each Function App's identity can reach only its own database, Key Vault and storage.

targetScope = 'subscription'

@allowed(['sandbox', 'production'])
param env string

@description('Azure region. Must be allowed by the subscription policy and support Flex Consumption and Cosmos DB.')
param location string

@allowed(['off', 'approval'])
@description('The write gate. Production stays off until Phase 8 and the go-live tests.')
param writeMode string

@description('Object ID of the owner (K) in Entra ID: az ad signed-in-user show --query id -o tsv')
param ownerObjectId string

@description('Sandbox only: DASHBOARD_KEY test sign-in and the /mcp connector. Refused in production.')
param sandboxConveniences bool = false

@description('Monthly budget alert, USD. Emails the subscription owners at 50%, 100% and forecast 100%.')
param monthlyBudgetUsd int = 5

@description('Start date of the budget period (first of a month, yyyy-MM-01).')
param budgetStart string = '2026-11-01'

@description('Create the monthly budget alert (turn off if the subscription offer does not support budgets).')
param createBudget bool = true

var suffix = take(uniqueString(subscription().id), 6)
var sharedRgName = 'rg-ebay-shared'
var envRgName = 'rg-ebay-${env}'
var cosmosName = 'cosmos-ebay-${suffix}'

resource sharedRg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: sharedRgName
  location: location
}

resource envRg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: envRgName
  location: location
}

module cosmos 'modules/cosmos.bicep' = {
  name: 'cosmos-${env}'
  scope: sharedRg
  params: {
    accountName: cosmosName
    location: location
    databaseName: 'ebay-${env}'
  }
}

module app 'modules/app.bicep' = {
  name: 'app-${env}'
  scope: envRg
  params: {
    env: env
    location: location
    suffix: suffix
    writeMode: env == 'production' ? 'off' : writeMode
    ownerObjectId: ownerObjectId
    sandboxConveniences: env == 'production' ? false : sandboxConveniences
    cosmosEndpoint: cosmos.outputs.endpoint
    cosmosDatabase: 'ebay-${env}'
  }
}

// The Function App may read and write its own database only; the owner may read it (diagnosis) and, on
// Sandbox, write it (tests and imports). Production writes by the owner are granted only for the switch-over
// import and removed afterwards (docs/azure-migration.md, M6).
module cosmosAccess 'modules/cosmos-access.bicep' = {
  name: 'cosmos-access-${env}'
  scope: sharedRg
  params: {
    accountName: cosmosName
    databaseName: 'ebay-${env}'
    appPrincipalId: app.outputs.principalId
    ownerObjectId: ownerObjectId
    ownerCanWrite: env == 'sandbox'
  }
}

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = if (createBudget) {
  name: 'ebay-monthly'
  properties: {
    category: 'Cost'
    amount: monthlyBudgetUsd
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStart }
    notifications: {
      half: { enabled: true, operator: 'GreaterThan', threshold: 50, contactEmails: [], contactRoles: ['Owner'], thresholdType: 'Actual' }
      full: { enabled: true, operator: 'GreaterThan', threshold: 100, contactEmails: [], contactRoles: ['Owner'], thresholdType: 'Actual' }
      forecast: { enabled: true, operator: 'GreaterThan', threshold: 100, contactEmails: [], contactRoles: ['Owner'], thresholdType: 'Forecasted' }
    }
  }
}

output functionAppName string = app.outputs.functionAppName
output publicUrl string = app.outputs.publicUrl
output keyVaultName string = app.outputs.keyVaultName
output storageAccountName string = app.outputs.storageAccountName
output resourceGroup string = envRgName
output cosmosAccount string = cosmosName
output cosmosEndpoint string = cosmos.outputs.endpoint
