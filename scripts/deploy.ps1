param(
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [string] $ResourceGroup = 'rg-matchlens-hackathon',
  [string] $Location = 'eastus2',
  [string] $ImageTag = (Get-Date -Format 'yyyyMMddHHmmss'),
  [switch] $ProvisionOnly,
  [switch] $UseExistingInfrastructure
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Invoke-Azure {
  param([string[]] $Arguments)
  $output = & az @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Azure command failed: $($Arguments[0..1] -join ' ')" }
  return $output
}

Push-Location $root
try {
  if ($UseExistingInfrastructure) {
    $coreJson = Invoke-Azure @('deployment', 'group', 'show', '--name', 'matchlens-core',
      '--resource-group', $ResourceGroup, '--subscription', $SubscriptionId,
      '--query', 'properties.outputs', '--output', 'json')
  } else {
    Invoke-Azure @('group', 'create', '--name', $ResourceGroup, '--location', $Location,
      '--subscription', $SubscriptionId, '--tags', 'application=MatchLens', 'purpose=synthetic-football-hackathon',
      '--output', 'none')
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

  Invoke-Azure @('acr', 'build', '--registry', $core.registryName.value,
    '--subscription', $SubscriptionId, '--image', "matchlens:$ImageTag", '--file', 'Dockerfile', '.',
    '--no-logs', '--output', 'none')

  # Eventstream connection strings are secrets: pass them through a temporary parameters file
  # (deleted afterwards) rather than the command line. They become Container Apps secrets.
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
  }
  $fabricSecrets = Join-Path $root 'fabric\.secrets.local.json'
  if (Test-Path $fabricSecrets) {
    $fabric = Get-Content $fabricSecrets -Raw | ConvertFrom-Json
    $parameters.eventstreamSourceConnectionString = @{ value = $fabric.eventstreamSourceConnectionString }
    $parameters.eventstreamDestinationConnectionString = @{ value = $fabric.eventstreamDestinationConnectionString }
    if ($fabric.eventstreamConsumerGroup) { $parameters.eventstreamConsumerGroup = @{ value = $fabric.eventstreamConsumerGroup } }
  } else {
    Write-Warning 'fabric/.secrets.local.json not found: the app will use the local live bus instead of Fabric Eventstream.'
  }
  # Optional telemetry: use the liveonair-insights Application Insights component when it exists.
  $insights = & az monitor app-insights component show --app liveonair-insights --resource-group $ResourceGroup `
    --subscription $SubscriptionId --query connectionString --output tsv 2>$null
  if ($LASTEXITCODE -eq 0 -and $insights) {
    $parameters.appInsightsConnectionString = @{ value = ($insights -join '').Trim() }
  }
  Remove-Variable insights -ErrorAction SilentlyContinue
  $parameterFile = Join-Path ([IO.Path]::GetTempPath()) "matchlens-app-$([guid]::NewGuid()).json"
  try {
    @{ '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'; contentVersion = '1.0.0.0'; parameters = $parameters } |
      ConvertTo-Json -Depth 5 | Set-Content -Path $parameterFile -Encoding utf8
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
    registry = $core.registryName.value
    foundryProject = $core.projectId.value
    modelDeployment = $core.deploymentName.value
  } | ConvertTo-Json
} finally {
  Pop-Location
}
