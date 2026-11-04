// Data-plane roles on one environment's database (Cosmos DB built-in roles):
// - the Function App's identity: Data Contributor, this database only;
// - the owner: Data Reader (diagnosis), plus Data Contributor on Sandbox (tests, imports).

param accountName string
param databaseName string
param appPrincipalId string
param ownerObjectId string
param ownerCanWrite bool

var reader = '00000000-0000-0000-0000-000000000001'
var contributor = '00000000-0000-0000-0000-000000000002'

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' existing = {
  name: accountName
}

var scope = '${account.id}/dbs/${databaseName}'

resource appWrite 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: account
  name: guid(account.id, databaseName, appPrincipalId, contributor)
  properties: {
    roleDefinitionId: '${account.id}/sqlRoleDefinitions/${contributor}'
    principalId: appPrincipalId
    scope: scope
  }
}

resource ownerRead 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: account
  name: guid(account.id, databaseName, ownerObjectId, reader)
  properties: {
    roleDefinitionId: '${account.id}/sqlRoleDefinitions/${reader}'
    principalId: ownerObjectId
    scope: scope
  }
}

resource ownerWrite 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = if (ownerCanWrite) {
  parent: account
  name: guid(account.id, databaseName, ownerObjectId, contributor)
  properties: {
    roleDefinitionId: '${account.id}/sqlRoleDefinitions/${contributor}'
    principalId: ownerObjectId
    scope: scope
  }
}
