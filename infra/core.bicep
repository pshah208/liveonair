targetScope = 'resourceGroup'

param location string = resourceGroup().location
param prefix string = 'matchlens'
param developerObjectId string = ''
param modelName string = 'gpt-4.1-mini'
param modelVersion string = '2025-04-14'
param modelCapacity int = 50
@description('AI Search region; East US 2 had no Search capacity when provisioned.')
param searchLocation string = 'eastus'

var suffix = uniqueString(resourceGroup().id)
var openAiRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var azureAiUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '53ca6127-db72-4b80-b1b0-d745d6d5456d')
var searchIndexReaderRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '1407120a-92aa-4202-b7e9-c0e197c71c8f')
var searchIndexContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8ebe5a00-799e-43f5-93ac-243d3dce84a7')
var searchServiceContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7ca78c08-252a-4471-8644-bb5ff32d4ba0')
var tags = { application: 'MatchLens', purpose: 'synthetic-football-hackathon' }

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-app-${suffix}'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${prefix}${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false, publicNetworkAccess: 'Enabled' }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs-${suffix}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json('0.1') }
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env-${suffix}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: '${prefix}-ai-${suffix}'
  location: location
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  tags: tags
  properties: {
    customSubDomainName: '${prefix}-ai-${suffix}'
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
    allowProjectManagement: true
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: foundry
  name: 'matchlens'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    displayName: 'MatchLens'
    description: 'Evidence-first synthetic football intelligence and bounded editorial AI.'
  }
}

resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: foundry
  name: 'matchlens-narrator'
  sku: { name: 'GlobalStandard', capacity: modelCapacity }
  properties: {
    model: { format: 'OpenAI', name: modelName, version: modelVersion }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
  dependsOn: [project]
}

resource modelAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, identity.id, openAiRoleId)
  scope: foundry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: openAiRoleId
  }
}

// Developer model access was granted once with the Azure CLI; see README. The roles below are
// additional developer data-plane roles needed to provision agents and the archive index.
resource developerAgentAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(developerObjectId)) {
  name: guid(foundry.id, developerObjectId, azureAiUserRoleId)
  scope: foundry
  properties: {
    principalId: developerObjectId
    principalType: 'User'
    roleDefinitionId: azureAiUserRoleId
  }
}

resource agentAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, identity.id, azureAiUserRoleId)
  scope: foundry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: azureAiUserRoleId
  }
}

resource search 'Microsoft.Search/searchServices@2024-06-01-preview' = {
  name: '${prefix}-search-${suffix}'
  location: searchLocation
  tags: tags
  sku: { name: 'basic' }
  identity: { type: 'SystemAssigned' }
  properties: {
    replicaCount: 1
    partitionCount: 1
    hostingMode: 'default'
    publicNetworkAccess: 'enabled'
    disableLocalAuth: true
    semanticSearch: 'free'
  }
}

resource searchReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, identity.id, searchIndexReaderRoleId)
  scope: search
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: searchIndexReaderRoleId
  }
}

resource developerSearchData 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(developerObjectId)) {
  name: guid(search.id, developerObjectId, searchIndexContributorRoleId)
  scope: search
  properties: {
    principalId: developerObjectId
    principalType: 'User'
    roleDefinitionId: searchIndexContributorRoleId
  }
}

resource developerSearchService 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(developerObjectId)) {
  name: guid(search.id, developerObjectId, searchServiceContributorRoleId)
  scope: search
  properties: {
    principalId: developerObjectId
    principalType: 'User'
    roleDefinitionId: searchServiceContributorRoleId
  }
}

resource imagePull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, acrPullRoleId)
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleId
  }
}

output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output environmentName string = environment.name
output identityName string = identity.name
output identityClientId string = identity.properties.clientId
output aiName string = foundry.name
output aiEndpoint string = 'https://${foundry.name}.openai.azure.com/'
output projectId string = project.id
output deploymentName string = deployment.name
output projectEndpoint string = 'https://${foundry.name}.services.ai.azure.com/api/projects/${project.name}'
output searchName string = search.name
output searchEndpoint string = 'https://${search.name}.search.windows.net'
