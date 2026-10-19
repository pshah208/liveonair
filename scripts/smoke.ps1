param(
  [Parameter(Mandatory)] [uri] $BaseUrl,
  [switch] $IncludeAI,
  # Starts a scripted live match on the target and checks the Studio storyline queue.
  # This changes the shared live state, so it is opt-in and refuses to interrupt a running match.
  [switch] $IncludeStorylines,
  [ValidateRange(0.0, 1.0)] [double] $MaxStorylineFailureRatio = 0.5,
  [ValidateRange(60, 1800)] [int] $StorylineTimeoutSeconds = 420
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

if ($IncludeStorylines) {
  # Regression guard for v0.13.0-v0.14.0, when every storyline failed the producer guard and nothing reached air.
  Assert-True ($health.ai.configured -eq $true) 'AI is not configured; the storyline desk cannot run'
  $liveStatus = Invoke-RestMethod -Uri "$base/api/live/status" -TimeoutSec 30
  Assert-True ($liveStatus.state -ne 'running') 'A live match is already running; refusing to interrupt it'
  $startBody = @{ fixtureId = $fixtures[0].id; speed = 60 } | ConvertTo-Json
  $null = Invoke-RestMethod -Uri "$base/api/live/start" -Method Post -ContentType 'application/json' -Body $startBody -TimeoutSec 30
  $inFlight = @('researching', 'checking', 'drafting')
  $deadline = (Get-Date).AddSeconds($StorylineTimeoutSeconds)
  $storylines = @()
  do {
    Start-Sleep -Seconds 10
    $liveStatus = Invoke-RestMethod -Uri "$base/api/live/status" -TimeoutSec 30
    # -NoEnumerate keeps the JSON array intact; @(Invoke-RestMethod ...) would wrap it as one element.
    $storylines = (Invoke-WebRequest -Uri "$base/api/studio/storylines" -TimeoutSec 30).Content | ConvertFrom-Json -NoEnumerate
    $pending = @($storylines | Where-Object { $_.status -in $inFlight }).Count
    $settled = $liveStatus.state -ne 'running' -and $storylines.Count -gt 0 -and $pending -eq 0
  } until ($settled -or (Get-Date) -gt $deadline)
  Assert-True $settled "Storyline queue did not settle within $StorylineTimeoutSeconds s"
  $failed = @($storylines | Where-Object { $_.status -eq 'failed' })
  $produced = $storylines.Count - $failed.Count
  Write-Output "Storylines: $($storylines.Count) total, $produced drafted, $($failed.Count) failed"
  foreach ($story in $failed) {
    Write-Output "  failed at $($story.triggerMinute)': $($story.failureReason)"
  }
  Assert-True ($produced -gt 0) 'Every storyline failed; nothing can reach air'
  Assert-True (($failed.Count / $storylines.Count) -le $MaxStorylineFailureRatio) `
    "Storyline failure ratio $($failed.Count)/$($storylines.Count) exceeds $MaxStorylineFailureRatio"
}

Write-Output "Live on Air smoke exercise passed for $base"
