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
    $coreJson = Invoke-Azure @('deployment', 'group', 'create', '--name', 'matchlens-core',
      '--resource-group', $ResourceGroup, '--subscription', $SubscriptionId,
      '--template-file', 'infra\core.bicep', '--parameters', "location=$Location",
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
  $appJson = Invoke-Azure @('deployment', 'group', 'create', '--name', 'matchlens-app',
    '--resource-group', $ResourceGroup, '--subscription', $SubscriptionId,
    '--template-file', 'infra\app.bicep', '--parameters', "location=$Location",
    "environmentName=$($core.environmentName.value)", "identityName=$($core.identityName.value)",
    "identityClientId=$($core.identityClientId.value)", "registryServer=$($core.registryServer.value)",
    "imageTag=$ImageTag", "aiEndpoint=$($core.aiEndpoint.value)",
    "deploymentName=$($core.deploymentName.value)", '--query', 'properties.outputs', '--output', 'json')
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
