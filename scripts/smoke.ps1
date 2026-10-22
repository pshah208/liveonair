param(
  [Parameter(Mandatory)] [uri] $BaseUrl,
  [switch] $IncludeAI,
  # Starts a scripted live match on the target and checks the Studio storyline queue.
  # This changes the shared live state, so it is opt-in and refuses to interrupt a running match.
  [switch] $IncludeStorylines,
  [ValidateRange(0.0, 1.0)] [double] $MaxStorylineFailureRatio = 0.5,
  [ValidateRange(60, 1800)] [int] $StorylineTimeoutSeconds = 420,
  # Bearer token for the Studio endpoints. When STUDIO_TOKEN is set on the app, every /api/studio/* route
  # (GET included) and the live start/stop/correction writes require it. Falls back to $env:STUDIO_TOKEN. Never printed.
  [securestring] $StudioToken,
  # Fail unless /api/live/status reports this transport. 'eventstream' is the current name (v0.15+);
  # 'fabric-eventstream' is the v0.14.x name. Both are accepted for either value, so a rollback still passes.
  # Any value other than 'local' also requires transportConfigured = true.
  [ValidateSet('', 'eventstream', 'fabric-eventstream', 'local')] [string] $ExpectTransport = '',
  # Fail unless the app enforces Studio auth (STUDIO_TOKEN is set). Use for every judging deploy.
  [switch] $ExpectStudioAuth
)

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.AbsoluteUri.TrimEnd('/')
$studioHeaders = @{}
if (-not $StudioToken -and $env:STUDIO_TOKEN) { $StudioToken = ConvertTo-SecureString $env:STUDIO_TOKEN -AsPlainText -Force }
if ($StudioToken) {
  $studioHeaders.Authorization = 'Bearer ' + [Net.NetworkCredential]::new('', $StudioToken).Password
}

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

$transportStatus = Invoke-RestMethod -Uri "$base/api/live/status" -TimeoutSec 30
Write-Output "Version: $($health.version)  Live transport: $($transportStatus.transport) (configured: $($transportStatus.transportConfigured))"
if ($ExpectTransport) {
  $eventstreamNames = @('eventstream', 'fabric-eventstream')
  $accepted = if ($ExpectTransport -eq 'local') { @('local') } else { $eventstreamNames }
  Assert-True ($transportStatus.transport -in $accepted) "Expected transport '$ExpectTransport' but got '$($transportStatus.transport)'"
  if ($ExpectTransport -ne 'local') {
    # 'eventstream' with configured=false would mean the secrets are gone; the fallback wrapper reports 'local' once it trips.
    Assert-True ($transportStatus.transportConfigured -eq $true) 'Eventstream transport is not configured (Eventstream secrets missing?)'
  }
}

# Studio auth. /api/studio/auth-required is public; everything else under /api/studio needs the bearer when it is on.
$studioAuth = Invoke-RestMethod -Uri "$base/api/studio/auth-required" -TimeoutSec 30
Write-Output "Studio auth required: $($studioAuth.required)"
if ($ExpectStudioAuth) {
  Assert-True ($studioAuth.required -eq $true) 'Studio auth is not enforced (STUDIO_TOKEN missing on the app?)'
}
if ($studioAuth.required -eq $true) {
  $anonymous = Invoke-WebRequest -Uri "$base/api/studio/health" -TimeoutSec 30 -SkipHttpErrorCheck
  Assert-True ($anonymous.StatusCode -eq 401) "Unauthenticated /api/studio/health returned $($anonymous.StatusCode), expected 401"
  if ($studioHeaders.Count -gt 0) {
    $authorized = Invoke-WebRequest -Uri "$base/api/studio/health" -Headers $studioHeaders -TimeoutSec 30 -SkipHttpErrorCheck
    Assert-True ($authorized.StatusCode -eq 200) "Authenticated /api/studio/health returned $($authorized.StatusCode); the token does not match the app"
  }
}

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
  Assert-True ($studioAuth.required -ne $true -or $studioHeaders.Count -gt 0) `
    'Studio auth is on: pass -StudioToken (or set $env:STUDIO_TOKEN) to run -IncludeStorylines'
  Assert-True ($health.ai.configured -eq $true) 'AI is not configured; the storyline desk cannot run'
  $liveStatus = Invoke-RestMethod -Uri "$base/api/live/status" -TimeoutSec 30
  Assert-True ($liveStatus.state -ne 'running') 'A live match is already running; refusing to interrupt it'
  $startBody = @{ fixtureId = $fixtures[0].id; speed = 60 } | ConvertTo-Json
  $null = Invoke-RestMethod -Uri "$base/api/live/start" -Method Post -ContentType 'application/json' -Body $startBody -Headers $studioHeaders -TimeoutSec 30
  $inFlight = @('researching', 'checking', 'drafting')
  $deadline = (Get-Date).AddSeconds($StorylineTimeoutSeconds)
  $storylines = @()
  do {
    Start-Sleep -Seconds 10
    $liveStatus = Invoke-RestMethod -Uri "$base/api/live/status" -TimeoutSec 30
    # -NoEnumerate keeps the JSON array intact; @(Invoke-RestMethod ...) would wrap it as one element.
    $storylines = (Invoke-WebRequest -Uri "$base/api/studio/storylines" -Headers $studioHeaders -TimeoutSec 30).Content | ConvertFrom-Json -NoEnumerate
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
