param(
  [Parameter(Mandatory)] [uri] $BaseUrl,
  [switch] $IncludeAI
)

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.AbsoluteUri.TrimEnd('/')

function Assert-True {
  param([bool] $Condition, [string] $Message)
  if (!$Condition) { throw $Message }
}

function Analyze {
  param([string] $FixtureId, [int] $Clock, [bool] $Correction)
  $body = @{
    fixtureId = $FixtureId
    atSecond = $Clock
    correction = $Correction
    persona = 'analyst'
    language = 'en'
  } | ConvertTo-Json
  Invoke-RestMethod -Uri "$base/api/analyze" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 30
}

$health = Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 30
Assert-True ($health.status -eq 'ok') 'Application is not healthy'
$fixtures = Invoke-RestMethod -Uri "$base/api/fixtures" -TimeoutSec 30
Assert-True ($fixtures.Count -eq 3) 'Expected three synthetic fixtures'

foreach ($summary in $fixtures) {
  $fixture = Invoke-RestMethod -Uri "$base/api/fixtures/$($summary.id)" -TimeoutSec 30
  $snapshot = Analyze $summary.id $summary.durationSeconds $false
  $corrected = Analyze $summary.id $summary.durationSeconds $true
  $unchangedViewer = Analyze $summary.id $summary.durationSeconds $false
  Assert-True ($snapshot.stateVersion -eq $unchangedViewer.stateVersion) 'Replay state leaked between visitors'
  Assert-True ($snapshot.stateVersion -ne $corrected.stateVersion) 'Correction did not invalidate the state'
  $before = $snapshot.score.home + $snapshot.score.away
  $after = $corrected.score.home + $corrected.score.away
  Assert-True ($before -eq $after + 1) 'Correction did not remove exactly one goal'
  Assert-True ($corrected.evidence.($fixture.correctionEventId).rescinded -eq $true) 'Correction audit record is missing'
  Assert-True ($corrected.evidenceCoverage -ge 0 -and $corrected.evidenceCoverage -le 100) 'Coverage is not a percentage'
  foreach ($story in $corrected.stories) {
    foreach ($id in $story.evidenceIds) {
      $event = $corrected.evidence.$id
      Assert-True ($null -ne $event -and !$event.rescinded) 'Story cites missing or rescinded evidence'
      Assert-True (($event.minute * 60 + $event.second) -le $corrected.atSecond) 'Story cites future evidence'
    }
  }
}

if ($IncludeAI) {
  Assert-True ($health.ai.configured -eq $true) 'AI is not configured'
  $body = @{
    fixtureId = $fixtures[0].id
    atSecond = 5400
    correction = $true
    persona = 'casual'
    language = 'es'
    format = 'recap'
  } | ConvertTo-Json
  $narrative = Invoke-RestMethod -Uri "$base/api/narrate" -Method Post `
    -ContentType 'application/json' -Body $body -TimeoutSec 90
  Assert-True ($narrative.source -eq 'foundry') 'Narration did not use Foundry'
  Assert-True ($narrative.claims.Count -gt 0) 'Narration has no grounded claims'
  Assert-True ($narrative.trace.Count -ge 3) 'Narration workflow trace is incomplete'
  Assert-True (![string]::IsNullOrWhiteSpace($narrative.script)) 'Narration has no script'
  Write-Output "Foundry recap: $($narrative.title)"
}

Write-Output "MatchLens smoke exercise passed for $base"
