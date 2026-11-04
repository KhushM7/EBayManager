// The one Cosmos DB for NoSQL account (free tier: 1,000 RU/s and 25 GB free) and one environment's database
// with its containers from infra/cosmos-containers.json. Key-based access is disabled: only Entra ID
// identities with a data-plane role can read or write (assigned in cosmos-access.bicep).

param accountName string
param location string
param databaseName string

var containers = loadJsonContent('../cosmos-containers.json').containers

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: accountName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    // Free tier can only be chosen when the account is created; one per subscription.
    enableFreeTier: true
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: false }]
    disableLocalAuth: true
    disableKeyBasedMetadataWriteAccess: true
    minimalTlsVersion: 'Tls12'
    publicNetworkAccess: 'Enabled'
    enableAutomaticFailover: false
    backupPolicy: { type: 'Periodic', periodicModeProperties: { backupIntervalInMinutes: 240, backupRetentionIntervalInHours: 8, backupStorageRedundancy: 'Local' } }
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: account
  name: databaseName
  properties: {
    resource: { id: databaseName }
    // 400 RU/s shared by this database's containers; two databases use 800 of the free 1,000.
    options: { throughput: 400 }
  }
}

resource container 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = [
  for c in containers: {
    parent: database
    name: c.id
    properties: {
      resource: union(
        {
          id: c.id
          partitionKey: { paths: ['/pk'], kind: 'Hash', version: 2 }
          indexingPolicy: union(
            {
              indexingMode: 'consistent'
              automatic: true
              includedPaths: map(c.indexed, p => { path: p })
              excludedPaths: [{ path: '/*' }, { path: '/"_etag"/?' }]
            },
            contains(c, 'composite') ? { compositeIndexes: c.composite } : {}
          )
        },
        c.defaultTtl != null ? { defaultTtl: c.defaultTtl } : {}
      )
    }
  }
]

output endpoint string = account.properties.documentEndpoint
