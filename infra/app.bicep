targetScope = 'resourceGroup'

param location string = resourceGroup().location
param appName string = 'liveonair'
param environmentName string
param identityName string
param identityClientId string
param registryServer string
param imageTag string
param aiEndpoint string
param deploymentName string = 'matchlens-narrator'
param aiMaxRequestsPerHour int = 120
param projectEndpoint string = ''
param searchEndpoint string = ''
param searchIndex string = 'matchlens-archive'
param searchKnowledgeBase string = 'matchlens-archive-kb'
param searchKnowledgeSource string = 'matchlens-archive'
@secure()
param eventstreamSourceConnectionString string = ''
@secure()
param eventstreamDestinationConnectionString string = ''
param eventstreamConsumerGroup string = '$Default'
@secure()
param appInsightsConnectionString string = ''
@description('Kill switch for post-match live web search. Queries leave the Azure compliance boundary.')
@allowed([
  'on'
  'off'
])
param narrativeWebSearch string = 'on'
@description('Bearer token for state-changing Studio/producer endpoints. Supplied at deploy time only; never committed.')
@secure()
param studioToken string = ''
@description('Idle minutes before the demo watchdog restarts a live demo match.')
@minValue(1)
param demoWatchdogMinutes int = 10
@description('Optional live source selector (for example opta-format). Empty leaves LIVE_SOURCE unset so the app default applies.')
param liveSource string = ''
param tags object = {
  application: 'LiveOnAir'
  purpose: 'synthetic-football-hackathon'
  project: 'pied-piper-soccer'
  'managed-by': 'copilot-agents'
}

var eventstreamConfigured = !empty(eventstreamSourceConnectionString) && !empty(eventstreamDestinationConnectionString)
var eventstreamSecrets = eventstreamConfigured ? [
  { name: 'eventstream-source', value: eventstreamSourceConnectionString }
  { name: 'eventstream-destination', value: eventstreamDestinationConnectionString }
] : []
var eventstreamEnv = eventstreamConfigured ? [
  { name: 'EVENTSTREAM_SOURCE_CONNECTION_STRING', secretRef: 'eventstream-source' }
  { name: 'EVENTSTREAM_DESTINATION_CONNECTION_STRING', secretRef: 'eventstream-destination' }
  { name: 'EVENTSTREAM_CONSUMER_GROUP', value: eventstreamConsumerGroup }
] : []
var telemetryConfigured = !empty(appInsightsConnectionString)
var telemetrySecrets = telemetryConfigured ? [
  { name: 'appinsights-connection', value: appInsightsConnectionString }
] : []
var telemetryEnv = telemetryConfigured ? [
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'appinsights-connection' }
] : []
var studioConfigured = !empty(studioToken)
var studioSecrets = studioConfigured ? [
  { name: 'studio-token', value: studioToken }
] : []
var studioEnv = studioConfigured ? [
  { name: 'STUDIO_TOKEN', secretRef: 'studio-token' }
] : []
var liveSourceEnv = empty(liveSource) ? [] : [
  { name: 'LIVE_SOURCE', value: liveSource }
]
var deskEnv = empty(projectEndpoint) ? [] : [
  { name: 'PROJECT_ENDPOINT', value: projectEndpoint }
]
var searchEnv = empty(searchEndpoint) ? [] : [
  { name: 'AZURE_SEARCH_ENDPOINT', value: searchEndpoint }
  { name: 'AZURE_SEARCH_INDEX', value: searchIndex }
  { name: 'AZURE_SEARCH_KNOWLEDGE_BASE', value: searchKnowledgeBase }
  { name: 'AZURE_SEARCH_KNOWLEDGE_SOURCE', value: searchKnowledgeSource }
]

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = { name: environmentName }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: identityName }

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 3000, transport: 'http', allowInsecure: false }
      registries: [{ server: registryServer, identity: identity.id }]
      // Secrets omitted here are REMOVED from the app on deploy; deploy.ps1 refuses to run without them.
      secrets: concat(eventstreamSecrets, telemetrySecrets, studioSecrets)
    }
    template: {
      containers: [{
        name: 'liveonair'
        image:'${registryServer}/matchlens:${imageTag}'
        // 1 vCPU / 2 GiB: headroom for Video lab ffmpeg and SSE fan-out during judging.
        resources: { cpu: json('1.0'), memory: '2Gi' }
        env: concat([
          { name: 'NODE_ENV', value: 'production' }
          { name: 'PORT', value: '3000' }
          { name: 'AZURE_CLIENT_ID', value: identityClientId }
          { name: 'AZURE_OPENAI_ENDPOINT', value: aiEndpoint }
          { name: 'AZURE_OPENAI_DEPLOYMENT', value: deploymentName }
          { name: 'AZURE_OPENAI_API_VERSION', value: '2024-10-21' }
          { name: 'AI_MAX_REQUESTS_PER_HOUR', value: string(aiMaxRequestsPerHour) }
          { name: 'AI_MAX_CONCURRENT', value: '2' }
          { name: 'NARRATIVE_WEB_SEARCH', value: narrativeWebSearch }
          { name: 'DEMO_WATCHDOG_MINUTES', value: string(demoWatchdogMinutes) }
        ], deskEnv, searchEnv, eventstreamEnv, telemetryEnv, studioEnv, liveSourceEnv)
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
        // minReplicas 1: never scale to zero during judging. maxReplicas 1: the live match, SSE fan-out and desk state are in-process, and
        // the Eventstream consumer must keep running between HTTP requests.
        minReplicas: 1
        maxReplicas: 1
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '20' } } }]
      }
    }
  }
}

output appUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output appId string = app.id
