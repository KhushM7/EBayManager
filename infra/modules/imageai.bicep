// The photo AI service (docs/imageai.md): one container on Azure Container Apps, consumption plan, scaled to
// zero. It runs only while a background removal, spot removal or upscale is being done, so it costs nothing
// idle; the first call after idle waits for it to start. No registry of our own (an Azure Container Registry
// costs money every day): the image is public on GitHub Container Registry, built by .github/workflows/imageai.yml.
// No Log Analytics either (logs would be billed): `az containerapp logs show` streams the console when needed.
//
// The shared key is the app's IMAGEAI-KEY (also in the Key Vault, where the Function App reads it). The
// container gets it as its own encrypted secret, passed in by scripts/azure-infra.mjs from the vars file:
// Azure creates new environments in "express" mode, which can't read Key Vault secrets (2026-11-13).
// The container's address is written to the vault (IMAGEAI-URL), where the Function App reads it.

param env string
param location string
param suffix string
param vaultName string
@description('The container image, e.g. ghcr.io/khushm7/ebaymanager-imageai:sha-abc1234 (pin a tag, not latest).')
param image string
@secure()
@description('The shared key (IMAGEAI_KEY from .dev.vars or .prod.vars), the same one the app sends.')
param key string

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

// Consumption only (no workload profiles, no dedicated plan): billed per second while a replica runs.
resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: 'cae-ebay-${env}-${suffix}'
  location: location
  properties: {
    zoneRedundant: false
  }
}

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: 'ca-imageai-${env}-${suffix}'
  location: location
  properties: {
    environmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
      }
      secrets: [
        { name: 'imageai-key', value: key }
      ]
    }
    template: {
      containers: [
        {
          name: 'imageai'
          image: image
          // 2 vCPU / 4 GiB: LaMa and IS-Net need about 1.8 GiB together (measured locally, 2026-11-13).
          resources: { cpu: json('2.0'), memory: '4Gi' }
          env: [
            { name: 'IMAGEAI_KEY', secretRef: 'imageai-key' }
            { name: 'ORT_THREADS', value: '2' }
          ]
          probes: [
            { type: 'Startup', httpGet: { path: '/health', port: 8080 }, periodSeconds: 3, failureThreshold: 40 }
          ]
        }
      ]
      scale: {
        // Zero when idle: nothing runs and nothing is billed until a request arrives.
        minReplicas: 0
        maxReplicas: 1
        // Back to zero 2 minutes after the last request (the default is 5), so a burst of edits shares one start.
        cooldownPeriod: 120
        rules: [
          { name: 'http', http: { metadata: { concurrentRequests: '4' } } }
        ]
      }
    }
  }
}

// Where the app finds the service: a Key Vault secret like the app's others (no circular dependency on the
// Function App's settings).
resource urlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'IMAGEAI-URL'
  properties: { value: 'https://${app.properties.configuration.ingress.fqdn}' }
}

output url string = 'https://${app.properties.configuration.ingress.fqdn}'
output appName string = app.name
