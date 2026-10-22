param(
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [string] $ResourceGroup = 'rg-matchlens-hackathon',
  [string] $Location = 'eastus2',
  [string] $ImageTag,
  [switch] $ProvisionOnly,
  [switch] $UseExistingInfrastructure,
  # Run `az deployment group what-if` for infra/app.bicep with the real parameters and print a redacted
  # summary. Builds no image and changes nothing. Without -ImageTag the currently deployed tag is reused.
  [switch] $PreviewOnly,
  # Deploy an image tag that already exists in ACR (rollback / config-only change). Without it, the tag is
  # built from the working tree, and the script refuses to overwrite an existing tag.
  [switch] $SkipBuild,
  # Optional. Omit to keep the bicep default for narrativeWebSearch ('on').
  [string] $NarrativeWebSearch,
  # Bearer token for the state-changing Studio endpoints. Falls back to $env:STUDIO_TOKEN. Never echoed.
  [securestring] $StudioToken,
  [ValidateRange(1, 240)] [int] $DemoWatchdogMinutes = 10,
  # Optional LIVE_SOURCE value (for example 'opta-format'). Empty leaves it unset.
  [string] $LiveSource = '',
  # Deploy without Fabric Eventstream secrets. The app then runs on its in-process local bus, and any
  # Eventstream secrets already on the container app are REMOVED by the deployment.
  [switch] $AllowLocalTransport,
  # Deploy without STUDIO_TOKEN. Producer endpoints are then unauthenticated. Not for judging.
  [switch] $AllowNoStudioToken
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Invoke-Azure {
  param([string[]] $Arguments)
  $output = & az @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Azure command failed: $($Arguments[0..2] -join ' ')" }
  return $output
}

function ConvertFrom-SecureStringPlain {
  param([securestring] $Value)
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

# Prints a what-if result without values for secret-like properties. ARM what-if can echo secure
# parameter values that land in non-secure properties (for example Container Apps secrets[].value).
function Write-RedactedWhatIf {
  param([string] $Json)
  $result = $Json | ConvertFrom-Json
  $sensitive = '(?i)secret|connection|token|password|key|value$'
  foreach ($change in $result.changes) {
    $name = ($change.resourceId -split '/providers/')[-1]
    Write-Output ("[{0}] {1}" -f $change.changeType, $name)
    $walk = {
      param($deltas, $indent)
      foreach ($delta in $deltas) {
        $detail = ''
        if ($delta.path -notmatch $sensitive -and $null -eq $delta.children) {
          $before = if ($null -ne $delta.before) { ($delta.before | ConvertTo-Json -Compress -Depth 6) } else { '-' }
          $after = if ($null -ne $delta.after) { ($delta.after | ConvertTo-Json -Compress -Depth 6) } else { '-' }
          if ($before.Length -gt 160) { $before = $before.Substring(0, 157) + '...' }
          if ($after.Length -gt 160) { $after = $after.Substring(0, 157) + '...' }
          $detail = " : $before => $after"
        } elseif ($delta.path -match $sensitive) {
          $detail = ' : (value redacted)'
        }
        Write-Output ("{0}{1} {2}{3}" -f $indent, $delta.propertyChangeType, $delta.path, $detail)
        if ($delta.children) { & $walk $delta.children ($indent + '  ') }
      }
    }
    if ($change.delta) { & $walk $change.delta '    ' }
  }
}

Push-Location $root
try {
  # ---- Preflight: required secrets and settings fail fast, before anything is built or deployed. ----
  $fabricSecrets = Join-Path $root 'fabric\.secrets.local.json'
  $fabric = $null
  if (Test-Path $fabricSecrets) { $fabric = Get-Content $fabricSecrets -Raw | ConvertFrom-Json }
  $fabricReady = $fabric -and $fabric.eventstreamSourceConnectionString -and $fabric.eventstreamDestinationConnectionString
  if (-not $fabricReady -and -not $ProvisionOnly) {
    if (-not $AllowLocalTransport) {
      throw ('Fabric Eventstream secrets are missing (fabric/.secrets.local.json needs eventstreamSourceConnectionString ' +
        'and eventstreamDestinationConnectionString). Deploying now would remove them from the container app. ' +
        'Pass -AllowLocalTransport to deploy on the local live bus deliberately.')
    }
    Write-Warning 'Deploying WITHOUT Fabric Eventstream: the app will use the local live bus (-AllowLocalTransport).'
  }

  if (-not $StudioToken -and $env:STUDIO_TOKEN) {
    $StudioToken = ConvertTo-SecureString $env:STUDIO_TOKEN -AsPlainText -Force
  }
  if (-not $StudioToken -and -not $ProvisionOnly) {
    if (-not $AllowNoStudioToken) {
      throw 'STUDIO_TOKEN is missing. Pass -StudioToken (SecureString) or set $env:STUDIO_TOKEN, or -AllowNoStudioToken for a non-judging deploy.'
    }
    Write-Warning 'Deploying WITHOUT STUDIO_TOKEN: producer endpoints are unauthenticated (-AllowNoStudioToken).'
  }

  if ($PSBoundParameters.ContainsKey('NarrativeWebSearch') -and $NarrativeWebSearch -notin @('on', 'off')) {
    throw "NarrativeWebSearch must be 'on' or 'off'."
  }

  if ($UseExistingInfrastructure -or $PreviewOnly) {
    $coreJson = Invoke-Azure @('deployment', 'group', 'show', '--name', 'matchlens-core',
      '--resource-group', $ResourceGroup, '--subscription', $SubscriptionId,
      '--query', 'properties.outputs', '--output', 'json')
  } else {
    Invoke-Azure @('group', 'create', '--name', $ResourceGroup, '--location', $Location,
      '--subscription', $SubscriptionId, '--tags', 'application=MatchLens', 'purpose=synthetic-football-hackathon',
      'project=pied-piper-soccer', 'managed-by=copilot-agents', '--output', 'none')
    # Resolve the signed-in developer from the target subscription's ARM token rather than the CLI's
    # default Graph tenant, which can differ in multi-tenant environments.
    $token = Invoke-Azure @('account', 'get-access-token', '--subscription', $SubscriptionId, '--query', 'accessToken', '--output', 'tsv')
    $payload = ($token -split '\.')[1].Replace('-', '+').Replace('_', '/')
    $payload = $payload.PadRight($payload.Length + (4 - $payload.Length % 4) % 4, '=')
    $developer = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json).oid
    Remove-Variable token, payload
    $coreJson = Invoke-Azure @('deployment', 'group', 'create', '--name', 'matchlens-core',
      '--resource-group', $ResourceGroup, '--subscription', $SubscriptionId,
      '--template-file', 'infra\core.bicep', '--parameters', "location=$Location", "developerObjectId=$developer",
      '--query', 'properties.outputs', '--output', 'json')
  }
  $core = ($coreJson -join "`n") | ConvertFrom-Json

  if ($ProvisionOnly) {
    $core | ConvertTo-Json -Depth 8
    return
  }

  # Application Insights is required: the availability test and alerts in infra/monitoring.bicep depend on it.
  $insights = & az monitor app-insights component show --app liveonair-insights --resource-group $ResourceGroup `
    --subscription $SubscriptionId --query connectionString --output tsv 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $insights) {
    throw 'Application Insights component liveonair-insights was not found; deploy infra/monitoring.bicep prerequisites first.'
  }

  if (-not $ImageTag) {
    if ($PreviewOnly) {
      $currentImage = Invoke-Azure @('containerapp', 'show', '--name', 'liveonair', '--resource-group', $ResourceGroup,
        '--subscription', $SubscriptionId, '--query', 'properties.template.containers[0].image', '--output', 'tsv')
      $ImageTag = (($currentImage -join '').Trim() -split ':')[-1]
    } else {
      $ImageTag = Get-Date -Format 'yyyyMMddHHmmss'
    }
  }

  if (-not $PreviewOnly) {
    $existingTags = Invoke-Azure @('acr', 'repository', 'show-tags', '--name', $core.registryName.value,
      '--resource-group', $ResourceGroup, '--subscription', $SubscriptionId, '--repository', 'matchlens', '--output', 'tsv')
    $tagExists = @($existingTags) -contains $ImageTag
    if ($SkipBuild) {
      if (-not $tagExists) { throw "Image matchlens:$ImageTag is not in $($core.registryName.value); cannot deploy it with -SkipBuild." }
    } else {
      if ($tagExists) { throw "Image matchlens:$ImageTag already exists; refusing to overwrite a rollback target. Use a new -ImageTag or -SkipBuild." }
      Invoke-Azure @('acr', 'build', '--registry', $core.registryName.value, '--resource-group', $ResourceGroup,
        '--subscription', $SubscriptionId, '--image', "matchlens:$ImageTag", '--file', 'Dockerfile', '.',
        '--no-logs', '--output', 'none')
    }
  }

  # Secrets reach ARM only through a temporary parameters file (deleted afterwards), never the command line.
  $parameters = @{
    location = @{ value = $Location }
    environmentName = @{ value = $core.environmentName.value }
    identityName = @{ value = $core.identityName.value }
    identityClientId = @{ value = $core.identityClientId.value }
    registryServer = @{ value = $core.registryServer.value }
    imageTag = @{ value = $ImageTag }
    aiEndpoint = @{ value = $core.aiEndpoint.value }
    deploymentName = @{ value = $core.deploymentName.value }
    projectEndpoint = @{ value = $core.projectEndpoint.value }
    searchEndpoint = @{ value = $core.searchEndpoint.value }
    appInsightsConnectionString = @{ value = ($insights -join '').Trim() }
    demoWatchdogMinutes = @{ value = $DemoWatchdogMinutes }
  }
  Remove-Variable insights
  if ($fabricReady) {
    $parameters.eventstreamSourceConnectionString = @{ value = $fabric.eventstreamSourceConnectionString }
    $parameters.eventstreamDestinationConnectionString = @{ value = $fabric.eventstreamDestinationConnectionString }
    if ($fabric.eventstreamConsumerGroup) { $parameters.eventstreamConsumerGroup = @{ value = $fabric.eventstreamConsumerGroup } }
  }
  Remove-Variable fabric
  if ($StudioToken) { $parameters.studioToken = @{ value = (ConvertFrom-SecureStringPlain $StudioToken) } }
  if ($LiveSource) { $parameters.liveSource = @{ value = $LiveSource } }
  if ($PSBoundParameters.ContainsKey('NarrativeWebSearch')) { $parameters.narrativeWebSearch = @{ value = $NarrativeWebSearch } }

  Write-Output ("Settings: image=matchlens:{0} fabric={1} studioToken={2} appInsights=set watchdog={3}m liveSource={4}" -f `
    $ImageTag, [bool]$fabricReady, [bool]$StudioToken, $DemoWatchdogMinutes, $(if ($LiveSource) { $LiveSource } else { '(unset)' }))

  $parameterFile = Join-Path ([IO.Path]::GetTempPath()) "matchlens-app-$([guid]::NewGuid()).json"
  try {
    @{ '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'; contentVersion = '1.0.0.0'; parameters = $parameters } |
      ConvertTo-Json -Depth 5 | Set-Content -Path $parameterFile -Encoding utf8
    $parameters.Clear()
    if ($PreviewOnly) {
      $whatIf = Invoke-Azure @('deployment', 'group', 'what-if', '--name', 'matchlens-app',
        '--resource-group', $ResourceGroup, '--subscription', $SubscriptionId,
        '--template-file', 'infra\app.bicep', '--parameters', "@$parameterFile",
        '--no-pretty-print', '--output', 'json')
      Write-RedactedWhatIf ($whatIf -join "`n")
      return
    }
    $appJson = Invoke-Azure @('deployment', 'group', 'create', '--name', 'matchlens-app',
      '--resource-group', $ResourceGroup, '--subscription', $SubscriptionId,
      '--template-file', 'infra\app.bicep', '--parameters', "@$parameterFile",
      '--query', 'properties.outputs', '--output', 'json')
  } finally {
    Remove-Item -LiteralPath $parameterFile -ErrorAction SilentlyContinue
  }
  $app = ($appJson -join "`n") | ConvertFrom-Json
  [pscustomobject]@{
    resourceGroup = $ResourceGroup
    location = $Location
    url = $app.appUrl.value
    image = "$($core.registryServer.value)/matchlens:$ImageTag"
    registry = $core.registryName.value
    foundryProject = $core.projectId.value
    modelDeployment = $core.deploymentName.value
  } | ConvertTo-Json
} finally {
  Pop-Location
}
