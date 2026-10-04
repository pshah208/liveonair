param(
  [string] $SubscriptionId = '5d2da101-2909-479c-a12f-c07083da7c18',
  [string] $CapacityId = '5b8534f0-4a8d-4730-b160-c486ac6e5ca7',
  [string] $WorkspaceName = 'MatchLens Live',
  [string] $EventhouseName = 'matchlens-eventhouse',
  [string] $RequestedDatabaseName = 'matchlens',
  [string] $EventstreamName = 'matchlens-live',
  [string] $EventstreamConnectionName = 'matchlens-eh-conn-v2',
  [switch] $SkipDataAgent
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path $PSScriptRoot -Parent
$fabricDir = Join-Path $root 'fabric'
$schemaPath = Join-Path $fabricDir 'schema.kql'
$eventstreamPath = Join-Path $fabricDir 'eventstream.json'
$secretsPath = Join-Path $fabricDir '.secrets.local.json'
$readmePath = Join-Path $fabricDir 'README.md'

if (!(Test-Path $fabricDir)) {
  New-Item -ItemType Directory -Path $fabricDir | Out-Null
}

$script:TokenCache = @{}

function Get-HeaderValue {
  param(
    [Parameter(Mandatory)] $Headers,
    [Parameter(Mandatory)][string] $Name,
    $Default = $null
  )

  $value = $Headers[$Name]
  if ($null -eq $value) {
    return $Default
  }

  if ($value -is [System.Array]) {
    return $value[0]
  }

  return $value
}

function Get-AzAccessToken {
  param([Parameter(Mandatory)][string] $Resource)

  $normalized = $Resource.TrimEnd('/')
  if ($script:TokenCache.ContainsKey($normalized)) {
    $cached = $script:TokenCache[$normalized]
    if ($cached.ExpiresOn -gt (Get-Date).AddMinutes(5)) {
      return $cached.Token
    }
  }

  $json = az account get-access-token --subscription $SubscriptionId --resource $normalized --output json 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($json -join "`n"))) {
    throw "Failed to acquire Azure token for resource $normalized."
  }

  $payload = ($json -join "`n") | ConvertFrom-Json
  $expiresOn =
    if ($payload.expiresOn) { [datetimeoffset]::Parse($payload.expiresOn).UtcDateTime }
    elseif ($payload.expires_on) { [datetimeoffset]::FromUnixTimeSeconds([long]$payload.expires_on).UtcDateTime }
    else { (Get-Date).AddMinutes(50) }

  $script:TokenCache[$normalized] = [pscustomobject]@{
    Token = $payload.accessToken
    ExpiresOn = $expiresOn
  }

  return $payload.accessToken
}

function Invoke-HttpJson {
  param(
    [Parameter(Mandatory)][string] $Method,
    [Parameter(Mandatory)][string] $Uri,
    [Parameter(Mandatory)][string] $Resource,
    [object] $Body,
    [int[]] $ExpectedStatusCodes = @(200),
    [switch] $Allow404
  )

  $attempt = 0
  while ($true) {
    $attempt++
    $token = Get-AzAccessToken -Resource $Resource
    $headers = @{
      Authorization = "Bearer $token"
      Accept        = 'application/json'
    }

    $invokeArgs = @{
      Method             = $Method
      Uri                = $Uri
      Headers            = $headers
      SkipHttpErrorCheck = $true
      UseBasicParsing    = $true
    }

    if ($null -ne $Body) {
      $invokeArgs['Body'] = ($Body | ConvertTo-Json -Depth 100 -Compress)
      $invokeArgs['ContentType'] = 'application/json'
    }

    $response = Invoke-WebRequest @invokeArgs
    $statusCode = [int]$response.StatusCode

    if ($Allow404 -and $statusCode -eq 404) {
      return $null
    }

    if ($statusCode -eq 429) {
      $retryAfter = [int](Get-HeaderValue -Headers $response.Headers -Name 'Retry-After' -Default 15)
      Start-Sleep -Seconds ([Math]::Max($retryAfter, 1))
      continue
    }

    if ($statusCode -notin $ExpectedStatusCodes) {
      $content = $response.Content
      throw "HTTP $statusCode calling $Method $Uri`n$content"
    }

    $json = $null
    if ($response.Content) {
      try { $json = $response.Content | ConvertFrom-Json -Depth 100 } catch { }
    }

    return [pscustomobject]@{
      StatusCode = $statusCode
      Headers    = $response.Headers
      Content    = $response.Content
      Json       = $json
    }
  }
}

function Wait-FabricLro {
  param(
    [Parameter(Mandatory)] $InitialResponse,
    [string] $ResultFallbackUri
  )

  if ($InitialResponse.StatusCode -eq 200 -or $InitialResponse.StatusCode -eq 201) {
    return $InitialResponse.Json
  }

  if ($InitialResponse.StatusCode -ne 202) {
    throw "Unexpected LRO status code $($InitialResponse.StatusCode)."
  }

  $location = [string](Get-HeaderValue -Headers $InitialResponse.Headers -Name 'Location')
  $operationId = [string](Get-HeaderValue -Headers $InitialResponse.Headers -Name 'x-ms-operation-id')
  if ([string]::IsNullOrWhiteSpace($location)) {
    throw 'Fabric LRO response did not include a Location header.'
  }

  while ($true) {
    $retryAfter = [int](Get-HeaderValue -Headers $InitialResponse.Headers -Name 'Retry-After' -Default 15)
    Start-Sleep -Seconds ([Math]::Max($retryAfter, 1))
    $poll = Invoke-HttpJson -Method Get -Uri $location -Resource 'https://api.fabric.microsoft.com' -ExpectedStatusCodes @(200, 201, 202)

    if ($poll.StatusCode -eq 202) {
      $InitialResponse = $poll
      continue
    }

    $status = $poll.Json.status
    if ($status -eq 'Failed') {
      throw ($poll.Content ?? 'Fabric long-running operation failed.')
    }

    if ($status -eq 'Succeeded' -or $status -eq $null) {
      break
    }

    $InitialResponse = $poll
  }

  if ($operationId) {
    $resultUri = "https://api.fabric.microsoft.com/v1/operations/$operationId/result"
    $result = Invoke-HttpJson -Method Get -Uri $resultUri -Resource 'https://api.fabric.microsoft.com' -ExpectedStatusCodes @(200) -Allow404
    if ($null -ne $result) {
      return $result.Json
    }
  }

  if ($ResultFallbackUri) {
    return (Invoke-HttpJson -Method Get -Uri $ResultFallbackUri -Resource 'https://api.fabric.microsoft.com' -ExpectedStatusCodes @(200)).Json
  }

  return $poll.Json
}

function Get-FabricCollection {
  param([Parameter(Mandatory)][string] $Uri)
  $result = Invoke-HttpJson -Method Get -Uri $Uri -Resource 'https://api.fabric.microsoft.com' -ExpectedStatusCodes @(200)
  if ($result.Json.value) { return @($result.Json.value) }
  return @()
}

function Get-OrCreateWorkspace {
  $workspaces = Get-FabricCollection -Uri 'https://api.fabric.microsoft.com/v1/workspaces'
  $existing = $workspaces | Where-Object { $_.displayName -eq $WorkspaceName -and $_.type -eq 'Workspace' } | Select-Object -First 1
  if ($existing) {
    return $existing
  }

  $body = @{
    displayName = $WorkspaceName
    capacityId  = $CapacityId
  }
  $response = Invoke-HttpJson -Method Post -Uri 'https://api.fabric.microsoft.com/v1/workspaces' -Resource 'https://api.fabric.microsoft.com' -Body $body -ExpectedStatusCodes @(201)
  return $response.Json
}

function Get-OrCreateEventhouse {
  param([Parameter(Mandatory)][string] $WorkspaceId)

  $uri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/eventhouses"
  $eventhouses = Get-FabricCollection -Uri $uri
  $existing = $eventhouses | Where-Object { $_.displayName -eq $EventhouseName } | Select-Object -First 1
  if ($existing) {
    return (Invoke-HttpJson -Method Get -Uri "$uri/$($existing.id)" -Resource 'https://api.fabric.microsoft.com' -ExpectedStatusCodes @(200)).Json
  }

  $body = @{ displayName = $EventhouseName }
  $create = Invoke-HttpJson -Method Post -Uri $uri -Resource 'https://api.fabric.microsoft.com' -Body $body -ExpectedStatusCodes @(201, 202)
  $created = Wait-FabricLro -InitialResponse $create
  if ($created.id) {
    return (Invoke-HttpJson -Method Get -Uri "$uri/$($created.id)" -Resource 'https://api.fabric.microsoft.com' -ExpectedStatusCodes @(200)).Json
  }
  return (Get-FabricCollection -Uri $uri | Where-Object { $_.displayName -eq $EventhouseName } | Select-Object -First 1)
}

function Resolve-KqlDatabase {
  param(
    [Parameter(Mandatory)][string] $WorkspaceId,
    [Parameter(Mandatory)] $Eventhouse
  )

  $baseUri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/kqlDatabases"
  $databases = Get-FabricCollection -Uri $baseUri
  $children = @($databases | Where-Object { $_.properties.parentEventhouseItemId -eq $Eventhouse.id })

  $requested = $children | Where-Object { $_.displayName -eq $RequestedDatabaseName } | Select-Object -First 1
  if ($requested) {
    return (Invoke-HttpJson -Method Get -Uri "$baseUri/$($requested.id)" -Resource 'https://api.fabric.microsoft.com' -ExpectedStatusCodes @(200)).Json
  }

  if ($Eventhouse.properties.databasesItemIds -and $Eventhouse.properties.databasesItemIds.Count -ge 1) {
    foreach ($databaseId in $Eventhouse.properties.databasesItemIds) {
      $candidate = Invoke-HttpJson -Method Get -Uri "$baseUri/$databaseId" -Resource 'https://api.fabric.microsoft.com' -ExpectedStatusCodes @(200)
      if ($candidate.Json) {
        return $candidate.Json
      }
    }
  }

  $createBody = @{
    displayName = $RequestedDatabaseName
    creationPayload = @{
      databaseType          = 'ReadWrite'
      parentEventhouseItemId = $Eventhouse.id
    }
  }
  $create = Invoke-HttpJson -Method Post -Uri $baseUri -Resource 'https://api.fabric.microsoft.com' -Body $createBody -ExpectedStatusCodes @(201, 202)
  $result = Wait-FabricLro -InitialResponse $create
  if ($result.id) {
    return (Invoke-HttpJson -Method Get -Uri "$baseUri/$($result.id)" -Resource 'https://api.fabric.microsoft.com' -ExpectedStatusCodes @(200)).Json
  }
  return (Get-FabricCollection -Uri $baseUri | Where-Object { $_.displayName -eq $RequestedDatabaseName } | Select-Object -First 1)
}

function Get-KqlCommandBlocks {
  param([Parameter(Mandatory)][string] $Path)

  $raw = Get-Content -Path $Path -Raw
  $blocks = $raw -split '(?m)^\s*// ---\s*$'
  $clean = foreach ($block in $blocks) {
    $trimmed = ($block -split "\r?\n" | Where-Object { $_ -notmatch '^\s*//.*$' }) -join "`n"
    $trimmed = $trimmed.Trim()
    if ($trimmed) { $trimmed }
  }
  return @($clean)
}

function Invoke-KustoMgmt {
  param(
    [Parameter(Mandatory)][string] $ClusterUri,
    [Parameter(Mandatory)][string] $DatabaseName,
    [Parameter(Mandatory)][string] $Command
  )

  $body = @{
    db  = $DatabaseName
    csl = $Command
  }
  return (Invoke-HttpJson -Method Post -Uri "$($ClusterUri.TrimEnd('/'))/v1/rest/mgmt" -Resource $ClusterUri -Body $body -ExpectedStatusCodes @(200)).Json
}

function Invoke-KustoQuery {
  param(
    [Parameter(Mandatory)][string] $ClusterUri,
    [Parameter(Mandatory)][string] $DatabaseName,
    [Parameter(Mandatory)][string] $Query
  )

  $body = @{
    db  = $DatabaseName
    csl = $Query
  }
  return (Invoke-HttpJson -Method Post -Uri "$($ClusterUri.TrimEnd('/'))/v1/rest/query" -Resource $ClusterUri -Body $body -ExpectedStatusCodes @(200)).Json
}

function Convert-KustoTableToObjects {
  param([Parameter(Mandatory)] $Response)

  if (-not $Response.Tables -or $Response.Tables.Count -eq 0) {
    return @()
  }

  $table = $Response.Tables[0]
  $columns = @($table.Columns)
  $rows = foreach ($row in @($table.Rows)) {
    $item = [ordered]@{}
    for ($i = 0; $i -lt $columns.Count; $i++) {
      $item[$columns[$i].ColumnName] = $row[$i]
    }
    [pscustomobject]$item
  }
  return @($rows)
}

function Ensure-KustoSchema {
  param(
    [Parameter(Mandatory)][string] $ClusterUri,
    [Parameter(Mandatory)][string] $DatabaseName
  )

  $commands = Get-KqlCommandBlocks -Path $schemaPath
  foreach ($command in $commands) {
    Invoke-KustoMgmt -ClusterUri $ClusterUri -DatabaseName $DatabaseName -Command $command | Out-Null
  }
}

function Get-EventstreamDefinitionParts {
  param(
    [Parameter(Mandatory)][string] $WorkspaceId,
    [Parameter(Mandatory)][string] $KqlDatabaseId,
    [Parameter(Mandatory)][string] $KqlDatabaseName
  )

  $template = Get-Content -Path $eventstreamPath -Raw
  $resolved = $template.Replace('__WORKSPACE_ID__', $WorkspaceId).Replace('__KQL_DATABASE_ITEM_ID__', $KqlDatabaseId).Replace('__CONNECTION_NAME__', $EventstreamConnectionName).Replace('__DATABASE_NAME__', $KqlDatabaseName)

  $platform = @{
    '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json'
    metadata  = @{
      type        = 'Eventstream'
      displayName = $EventstreamName
    }
    config    = @{
      version   = '2.0'
      logicalId = '00000000-0000-0000-0000-000000000000'
    }
  } | ConvertTo-Json -Depth 20

  return @(
    @{
      path        = 'eventstream.json'
      payload     = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($resolved))
      payloadType = 'InlineBase64'
    },
    @{
      path        = '.platform'
      payload     = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($platform))
      payloadType = 'InlineBase64'
    }
  )
}

function Get-OrCreateEventstream {
  param(
    [Parameter(Mandatory)][string] $WorkspaceId,
    [Parameter(Mandatory)][string] $KqlDatabaseId,
    [Parameter(Mandatory)][string] $KqlDatabaseName
  )

  $listUri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/eventstreams"
  $existing = (Get-FabricCollection -Uri $listUri | Where-Object { $_.displayName -eq $EventstreamName } | Select-Object -First 1)
  $parts = Get-EventstreamDefinitionParts -WorkspaceId $WorkspaceId -KqlDatabaseId $KqlDatabaseId -KqlDatabaseName $KqlDatabaseName

  if ($existing) {
    $updateUri = "$listUri/$($existing.id)/updateDefinition?updateMetadata=true"
    $updateBody = @{ definition = @{ parts = $parts } }
    $update = Invoke-HttpJson -Method Post -Uri $updateUri -Resource 'https://api.fabric.microsoft.com' -Body $updateBody -ExpectedStatusCodes @(200, 202)
    if ($update.StatusCode -eq 202) {
      Wait-FabricLro -InitialResponse $update | Out-Null
    }
    return (Invoke-HttpJson -Method Get -Uri "$listUri/$($existing.id)" -Resource 'https://api.fabric.microsoft.com' -ExpectedStatusCodes @(200)).Json
  }

  $createUri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/items"
  $createBody = @{
    displayName = $EventstreamName
    description = 'Custom endpoint in, Eventhouse + custom endpoint out for MatchLens live envelopes.'
    type        = 'Eventstream'
    definition  = @{
      parts = $parts
    }
  }
  $create = Invoke-HttpJson -Method Post -Uri $createUri -Resource 'https://api.fabric.microsoft.com' -Body $createBody -ExpectedStatusCodes @(201, 202)
  $created = Wait-FabricLro -InitialResponse $create
  if ($created.id) {
    return (Invoke-HttpJson -Method Get -Uri "$listUri/$($created.id)" -Resource 'https://api.fabric.microsoft.com' -ExpectedStatusCodes @(200)).Json
  }
  return (Get-FabricCollection -Uri $listUri | Where-Object { $_.displayName -eq $EventstreamName } | Select-Object -First 1)
}

function Resume-Eventstream {
  param(
    [Parameter(Mandatory)][string] $WorkspaceId,
    [Parameter(Mandatory)][string] $EventstreamId
  )

  $uri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/eventstreams/$EventstreamId/resume"
  try {
    Invoke-HttpJson -Method Post -Uri $uri -Resource 'https://api.fabric.microsoft.com' -ExpectedStatusCodes @(200, 202) | Out-Null
  } catch {
    if ($_.Exception.Message -notmatch 'already' -and $_.Exception.Message -notmatch 'Invalid') {
      throw
    }
  }
}

function Wait-ForEventstreamTopology {
  param(
    [Parameter(Mandatory)][string] $WorkspaceId,
    [Parameter(Mandatory)][string] $EventstreamId,
    [int] $TimeoutSeconds = 300
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $uri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/eventstreams/$EventstreamId/topology"
  do {
    $topology = (Invoke-HttpJson -Method Get -Uri $uri -Resource 'https://api.fabric.microsoft.com' -ExpectedStatusCodes @(200)).Json
    $source = @($topology.sources | Where-Object { $_.name -eq 'matchlens-feed-in' } | Select-Object -First 1)
    $eventhouseDestination = @($topology.destinations | Where-Object { $_.name -eq 'matchlens-eventhouse' } | Select-Object -First 1)
    $appDestination = @($topology.destinations | Where-Object { $_.name -eq 'matchlens-app-out' } | Select-Object -First 1)

    if ($source -and $eventhouseDestination -and $appDestination) {
      return $topology
    }

    Start-Sleep -Seconds 10
  } while ((Get-Date) -lt $deadline)

  throw 'Timed out waiting for eventstream topology to materialize.'
}

function Get-EventstreamConnectionDetails {
  param(
    [Parameter(Mandatory)][string] $WorkspaceId,
    [Parameter(Mandatory)][string] $EventstreamId,
    [Parameter(Mandatory)] $Topology
  )

  $source = @($Topology.sources | Where-Object { $_.name -eq 'matchlens-feed-in' } | Select-Object -First 1)
  $destination = @($Topology.destinations | Where-Object { $_.name -eq 'matchlens-app-out' } | Select-Object -First 1)
  if (-not $source -or -not $destination) {
    throw 'Eventstream topology did not include the required custom endpoint nodes.'
  }

  $deadline = (Get-Date).AddMinutes(5)
  $sourceConnection = $null
  $destinationConnection = $null

  do {
    try {
      $sourceConnection = (Invoke-HttpJson -Method Get -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/eventstreams/$EventstreamId/sources/$($source.id)/connection" -Resource 'https://api.fabric.microsoft.com' -ExpectedStatusCodes @(200)).Json
      $destinationConnection = (Invoke-HttpJson -Method Get -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/eventstreams/$EventstreamId/destinations/$($destination.id)/connection" -Resource 'https://api.fabric.microsoft.com' -ExpectedStatusCodes @(200)).Json
      break
    } catch {
      if ((Get-Date) -ge $deadline) {
        throw
      }
      Start-Sleep -Seconds 15
    }
  } while ($true)

  return [pscustomobject]@{
    Source          = $source
    Destination     = $destination
    SourceConnection = $sourceConnection
    DestinationConnection = $destinationConnection
  }
}

function Write-SecretsFile {
  param(
    [Parameter(Mandatory)] $Workspace,
    [Parameter(Mandatory)] $Eventhouse,
    [Parameter(Mandatory)] $KqlDatabase,
    [Parameter(Mandatory)] $Eventstream,
    [Parameter(Mandatory)] $Topology,
    [Parameter(Mandatory)] $Connections
  )

  $payload = [ordered]@{
    workspaceId                          = $Workspace.id
    workspaceName                        = $Workspace.displayName
    capacityId                           = $Workspace.capacityId
    eventhouseId                         = $Eventhouse.id
    eventhouseName                       = $Eventhouse.displayName
    kqlDatabaseId                        = $KqlDatabase.id
    databaseName                         = $KqlDatabase.displayName
    queryServiceUri                      = $KqlDatabase.properties.queryServiceUri
    ingestionServiceUri                  = $KqlDatabase.properties.ingestionServiceUri
    eventstreamId                        = $Eventstream.id
    eventstreamName                      = $Eventstream.displayName
    eventstreamSourceId                  = $Connections.Source.id
    eventstreamDestinationId             = $Connections.Destination.id
    eventstreamSourceConnectionString    = $Connections.SourceConnection.accessKeys.primaryConnectionString
    eventstreamDestinationConnectionString = $Connections.DestinationConnection.accessKeys.primaryConnectionString
    eventstreamConsumerGroup             = $Connections.DestinationConnection.consumerGroupName
  }

  $payload | ConvertTo-Json -Depth 10 | Set-Content -Path $secretsPath
}

function Get-ArchiveCountSummaryQuery {
  @"
union
  (Clubs | summarize Count = count() | project TableName = "Clubs", Count),
  (People | summarize Count = count() | project TableName = "People", Count),
  (HistoricMatches | summarize Count = count() | project TableName = "HistoricMatches", Count),
  (HistoricGoals | summarize Count = count() | project TableName = "HistoricGoals", Count),
  (Honours | summarize Count = count() | project TableName = "Honours", Count),
  (Relations | summarize Count = count() | project TableName = "Relations", Count)
| order by TableName asc
"@
}

function Try-CreateDataAgent {
  param(
    [Parameter(Mandatory)][string] $WorkspaceId,
    [Parameter(Mandatory)] $KqlDatabase
  )

  if ($SkipDataAgent) {
    return [pscustomobject]@{
      Status = 'Skipped'
      Reason = 'SkipDataAgent switch was specified.'
    }
  }

  $listUri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/dataAgents"
  try {
    $existing = Get-FabricCollection -Uri $listUri | Where-Object { $_.displayName -eq 'matchlens-producer-desk' } | Select-Object -First 1
    if ($existing) {
      return [pscustomobject]@{
        Status = 'Exists'
        Id     = $existing.id
      }
    }
  } catch {
    return [pscustomobject]@{
      Status = 'Manual'
      Reason = 'The data agent list API is unavailable for this workspace or capacity.'
    }
  }

  $definitionParts = @(
    @{
      path        = 'Files/Config/data_agent.json'
      payload     = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(@'
{
  "$schema": "2.1.0"
}
'@))
      payloadType = 'InlineBase64'
    },
    @{
      path        = 'Files/Config/draft/stage_config.json'
      payload     = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(@'
{
  "$schema": "1.0.0",
  "aiInstructions": "Answer producer questions about the synthetic MatchLens archive and live events using the KQL functions in this database; never invent facts."
}
'@))
      payloadType = 'InlineBase64'
    },
    @{
      path        = 'Files/Config/draft/kusto-matchlens/datasource.json'
      payload     = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{
        '$schema'              = '1.0.0'
        artifactId             = $KqlDatabase.id
        workspaceId            = $WorkspaceId
        displayName            = $KqlDatabase.displayName
        type                   = 'kusto'
        userDescription        = 'Synthetic MatchLens archive plus live-event tables and helper functions.'
        dataSourceInstructions = 'Prefer the helper functions LiveTimeline, LiveScore, HeadToHead, PlayerCareer, FamilyLinks, and FinalsBetween before writing raw KQL.'
      } | ConvertTo-Json -Depth 20)))
      payloadType = 'InlineBase64'
    }
  )

  $body = @{
    displayName = 'matchlens-producer-desk'
    description = 'Producer-facing Fabric data agent for MatchLens synthetic archive and live events.'
    definition  = @{
      parts = $definitionParts
    }
  }

  try {
    $create = Invoke-HttpJson -Method Post -Uri $listUri -Resource 'https://api.fabric.microsoft.com' -Body $body -ExpectedStatusCodes @(201, 202)
    $result = Wait-FabricLro -InitialResponse $create
    return [pscustomobject]@{
      Status = 'Created'
      Id     = $result.id
    }
  } catch {
    return [pscustomobject]@{
      Status = 'Manual'
      Reason = $_.Exception.Message
    }
  }
}

function Write-Readme {
  param(
    [Parameter(Mandatory)] $Workspace,
    [Parameter(Mandatory)] $Eventhouse,
    [Parameter(Mandatory)] $KqlDatabase,
    [Parameter(Mandatory)] $Eventstream,
    [Parameter(Mandatory)] $Connections,
    [Parameter(Mandatory)] $ArchiveCounts,
    [Parameter(Mandatory)] $DataAgentResult
  )

  $bt = [char]96
  $manualDataAgent = ''
  if ($DataAgentResult.Status -eq 'Manual') {
    $manualDataAgent = @"

## Fabric data agent manual steps

The public REST API didn't complete the ${bt}matchlens-producer-desk${bt} data agent on this trial-backed workspace.

1. Open the **MatchLens Live** workspace in Fabric.
2. Select **+ New item** > **Fabric data agent**.
3. Name it ${bt}matchlens-producer-desk${bt}.
4. Add the KQL database ${bt}$($KqlDatabase.displayName)${bt} as the source.
5. Keep the helper tables selected and use this instruction text:
   ${bt}Answer producer questions about the synthetic MatchLens archive and live events using the KQL functions; never invent facts.${bt}
6. Publish the agent when you're satisfied with the draft.
"@
  }

  $archiveList = ($ArchiveCounts | ForEach-Object { "- $($_.TableName): $($_.Count)" }) -join "`n"
  $dataAgentSummary =
    if ($DataAgentResult.Status -eq 'Created' -or $DataAgentResult.Status -eq 'Exists') {
      "- Status: $($DataAgentResult.Status)`n- Item ID: $($DataAgentResult.Id)"
    } else {
      "- Status: $($DataAgentResult.Status)`n- Notes: $($DataAgentResult.Reason)"
    }

  $content = @"
# MatchLens Live Fabric real-time layer

This workspace was provisioned with ${bt}scripts/provision-fabric.ps1${bt}.

## Provisioned items

- Workspace: ${bt}$($Workspace.displayName)${bt} (${bt}$($Workspace.id)${bt})
- Capacity: Fabric TRIAL (${bt}$($Workspace.capacityId)${bt})
- Eventhouse: ${bt}$($Eventhouse.displayName)${bt} (${bt}$($Eventhouse.id)${bt})
- KQL database: ${bt}$($KqlDatabase.displayName)${bt} (${bt}$($KqlDatabase.id)${bt})
- Query URI: ${bt}$($KqlDatabase.properties.queryServiceUri)${bt}
- Eventstream: ${bt}$($Eventstream.displayName)${bt} (${bt}$($Eventstream.id)${bt})
- Eventstream source: ${bt}matchlens-feed-in${bt} (${bt}$($Connections.Source.id)${bt})
- Eventstream destination: ${bt}matchlens-app-out${bt} (${bt}$($Connections.Destination.id)${bt})

## Architecture

${bt}${bt}${bt}text
simulator / smoke publisher
        |
        v
  Eventstream source: matchlens-feed-in
        |
        v
    Eventstream: matchlens-live
      /                     \
     v                       v
Eventhouse.MatchEventsRaw  Custom endpoint: matchlens-app-out
 (processed ingestion)          |
     |                          v
     v update policy           app
Eventhouse.MatchEvents
${bt}${bt}${bt}

## Rerun

${bt}${bt}${bt}powershell
pwsh -File scripts/provision-fabric.ps1
npx tsx scripts/eventstream-smoke.ts
npx tsx scripts/load-archive-fabric.ts
${bt}${bt}${bt}

## Producer KQL examples

${bt}${bt}${bt}kusto
LiveTimeline("smoke-123")
LiveScore("smoke-123")
HeadToHead("club-rivergate", "club-northbridge")
PlayerCareer("per-rivergate-milo-hart")
FamilyLinks("per-legend-cassian-arden")
FinalsBetween("club-rivergate", "club-northbridge")
${bt}${bt}${bt}

## Archive load counts

$archiveList

## Fabric data agent

$dataAgentSummary

## Connection material

Secrets were written to ${bt}fabric/.secrets.local.json${bt} only. No connection strings are recorded here.

## Teardown

Delete the **MatchLens Live** workspace to remove every provisioned Fabric artifact in one step.
$manualDataAgent
"@

  Set-Content -Path $readmePath -Value $content
}

$workspace = Get-OrCreateWorkspace
$eventhouse = Get-OrCreateEventhouse -WorkspaceId $workspace.id
$kqlDatabase = Resolve-KqlDatabase -WorkspaceId $workspace.id -Eventhouse $eventhouse

Ensure-KustoSchema -ClusterUri $kqlDatabase.properties.queryServiceUri -DatabaseName $kqlDatabase.displayName

$eventstream = Get-OrCreateEventstream -WorkspaceId $workspace.id -KqlDatabaseId $kqlDatabase.id -KqlDatabaseName $kqlDatabase.displayName
Resume-Eventstream -WorkspaceId $workspace.id -EventstreamId $eventstream.id
$topology = Wait-ForEventstreamTopology -WorkspaceId $workspace.id -EventstreamId $eventstream.id
$connections = Get-EventstreamConnectionDetails -WorkspaceId $workspace.id -EventstreamId $eventstream.id -Topology $topology

Write-SecretsFile -Workspace $workspace -Eventhouse $eventhouse -KqlDatabase $kqlDatabase -Eventstream $eventstream -Topology $topology -Connections $connections

$archiveCountsResponse = Invoke-KustoQuery -ClusterUri $kqlDatabase.properties.queryServiceUri -DatabaseName $kqlDatabase.displayName -Query (Get-ArchiveCountSummaryQuery)
$archiveCounts = Convert-KustoTableToObjects -Response $archiveCountsResponse

$dataAgentResult = Try-CreateDataAgent -WorkspaceId $workspace.id -KqlDatabase $kqlDatabase
Write-Readme -Workspace $workspace -Eventhouse $eventhouse -KqlDatabase $kqlDatabase -Eventstream $eventstream -Connections $connections -ArchiveCounts $archiveCounts -DataAgentResult $dataAgentResult

[pscustomobject]@{
  workspaceId             = $workspace.id
  eventhouseId            = $eventhouse.id
  kqlDatabaseId           = $kqlDatabase.id
  databaseName            = $kqlDatabase.displayName
  queryServiceUri         = $kqlDatabase.properties.queryServiceUri
  eventstreamId           = $eventstream.id
  sourceId                = $connections.Source.id
  destinationId           = $connections.Destination.id
  secretsFileWritten      = (Test-Path $secretsPath)
  dataAgentStatus         = $dataAgentResult.Status
  dataAgentId             = $dataAgentResult.Id
  archiveCounts           = $archiveCounts
} | ConvertTo-Json -Depth 10
