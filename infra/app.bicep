targetScope = 'resourceGroup'

param location string = resourceGroup().location
param appName string = 'matchlens'
param environmentName string
param identityName string
param identityClientId string
param registryServer string
param imageTag string
param aiEndpoint string
param deploymentName string = 'matchlens-narrator'
param aiMaxRequestsPerHour int = 60

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = { name: environmentName }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: identityName }

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: { application: 'MatchLens', purpose: 'synthetic-football-hackathon' }
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 3000, transport: 'http', allowInsecure: false }
      registries: [{ server: registryServer, identity: identity.id }]
    }
    template: {
      containers: [{
        name: 'matchlens'
        image: '${registryServer}/matchlens:${imageTag}'
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'PORT', value: '3000' }
          { name: 'AZURE_CLIENT_ID', value: identityClientId }
          { name: 'AZURE_OPENAI_ENDPOINT', value: aiEndpoint }
          { name: 'AZURE_OPENAI_DEPLOYMENT', value: deploymentName }
          { name: 'AZURE_OPENAI_API_VERSION', value: '2024-10-21' }
          { name: 'AI_MAX_REQUESTS_PER_HOUR', value: string(aiMaxRequestsPerHour) }
          { name: 'AI_MAX_CONCURRENT', value: '2' }
        ]
        probes: [
          {
            type: 'Startup'
            httpGet: { path: '/api/health', port: 3000 }
            initialDelaySeconds: 3
            periodSeconds: 5
            failureThreshold: 30
          }
          {
            type: 'Readiness'
            httpGet: { path: '/api/health', port: 3000 }
            periodSeconds: 10
          }
          {
            type: 'Liveness'
            httpGet: { path: '/api/health', port: 3000 }
            periodSeconds: 30
          }
        ]
      }]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '20' } } }]
      }
    }
  }
}

output appUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output appId string = app.id
