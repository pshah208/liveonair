// Monitoring for the Live on Air container app during judging (Oct 27 - Nov 10, 2026).
// Adopts the existing Application Insights component (no recreate) and adds:
// - a standard availability test on /api/health from three locations every 5 minutes;
// - alerts for availability, container restarts, zero replicas and memory pressure;
// - an action group (email receivers optional) and a resource group consumption budget.
targetScope = 'resourceGroup'

@description('Must match the Application Insights component region (eastus2); web tests live beside their component.')
param location string = resourceGroup().location
@description('Existing workspace-based Application Insights component. Referenced, never recreated.')
param appInsightsName string = 'liveonair-insights'
@description('Existing container app to monitor.')
param containerAppName string = 'liveonair'
@description('Health endpoint path served by server/app.ts.')
param healthPath string = '/api/health'
@description('Alert email address. Empty means the action group has no receivers (alerts still show in the portal).')
param alertEmail string = ''
@description('Monthly consumption budget for the whole resource group, in the billing currency (USD).')
param budgetAmount int = 100
@description('Budget start: the first day of a month, not earlier than the current month at deployment time.')
param budgetStartDate string = '2026-10-01'
param tags object = {
  project: 'pied-piper-soccer'
  'managed-by': 'copilot-agents'
  application: 'LiveOnAir'
}

var hasEmail = !empty(alertEmail)
// Standard-test location IDs (East US, South Central US, North Central US).
var testLocations = [
  { Id: 'us-va-ash-azr' }
  { Id: 'us-tx-sn1-azr' }
  { Id: 'us-il-ch1-azr' }
]

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = { name: appInsightsName }
resource app 'Microsoft.App/containerApps@2024-03-01' existing = { name: containerAppName }

var healthUrl = 'https://${app.properties.configuration.ingress.fqdn}${healthPath}'

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-liveonair'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'liveonair'
    enabled: true
    emailReceivers: hasEmail ? [
      { name: 'oncall-email', emailAddress: alertEmail, useCommonAlertSchema: true }
    ] : []
  }
}

resource healthTest 'Microsoft.Insights/webtests@2022-06-15' = {
  name: 'liveonair-health'
  location: location
  kind: 'standard'
  // The hidden-link tag binds the test to the component; without it the test is orphaned.
  tags: union(tags, { 'hidden-link:${appInsights.id}': 'Resource' })
  properties: {
    SyntheticMonitorId: 'liveonair-health'
    Name: 'Live on Air /api/health'
    Description: 'Judging-period uptime check for ${healthPath}.'
    Enabled: true
    Frequency: 300
    Timeout: 30
    Kind: 'standard'
    RetryEnabled: true
    Locations: testLocations
    Request: {
      RequestUrl: healthUrl
      HttpVerb: 'GET'
      ParseDependentRequests: false
    }
    ValidationRules: {
      ExpectedHttpStatusCode: 200
      SSLCheck: true
      SSLCertRemainingLifetimeCheck: 7
      ContentValidation: {
        ContentMatch: '"status":"ok"'
        IgnoreCase: false
        PassIfTextFound: true
      }
    }
  }
}

resource availabilityAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'liveonair-availability'
  location: 'global'
  tags: tags
  properties: {
    description: '/api/health failed from at least 2 of 3 test locations.'
    severity: 1
    enabled: true
    scopes: [ healthTest.id, appInsights.id ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria'
      webTestId: healthTest.id
      componentId: appInsights.id
      failedLocationCount: 2
    }
    actions: [ { actionGroupId: actionGroup.id } ]
  }
}

resource restartAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'liveonair-restarts'
  location: 'global'
  tags: tags
  properties: {
    description: 'A liveonair replica restarted (RestartCount is a per-replica cumulative gauge).'
    severity: 2
    enabled: true
    scopes: [ app.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'restarts'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'RestartCount'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Maximum'
        }
      ]
    }
    actions: [ { actionGroupId: actionGroup.id } ]
  }
}

resource noReplicaAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'liveonair-no-replicas'
  location: 'global'
  tags: tags
  properties: {
    description: 'liveonair has no running replica (minReplicas is 1, so this means it is down or stuck provisioning).'
    severity: 1
    enabled: true
    scopes: [ app.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'replicas'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'Replicas'
          operator: 'LessThan'
          threshold: 1
          timeAggregation: 'Maximum'
        }
      ]
    }
    actions: [ { actionGroupId: actionGroup.id } ]
  }
}

resource memoryAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'liveonair-memory'
  location: 'global'
  tags: tags
  properties: {
    description: 'liveonair memory above 85% of its limit (Video lab / ffmpeg pressure precedes OOM restarts).'
    severity: 3
    enabled: true
    scopes: [ app.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'memory'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'MemoryPercentage'
          operator: 'GreaterThan'
          threshold: 85
          timeAggregation: 'Average'
        }
      ]
    }
    actions: [ { actionGroupId: actionGroup.id } ]
  }
}

// Budgets do not support tags. Notifications go to RG Owners/Contributors and the action group,
// plus the alert email when one is supplied.
resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'budget-rg-matchlens-hackathon'
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: {
      actual80: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: hasEmail ? [ alertEmail ] : []
        contactRoles: [ 'Owner', 'Contributor' ]
        contactGroups: [ actionGroup.id ]
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: hasEmail ? [ alertEmail ] : []
        contactRoles: [ 'Owner', 'Contributor' ]
        contactGroups: [ actionGroup.id ]
      }
    }
  }
}

output healthTestUrl string = healthUrl
output webTestId string = healthTest.id
output actionGroupId string = actionGroup.id
