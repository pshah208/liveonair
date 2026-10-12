# Live on Air Fabric real-time layer

This workspace was provisioned with `scripts/provision-fabric.ps1`.

Live on Air is the product brand. The legacy `MatchLens Live` workspace name and all
`matchlens-*` resource names, IDs, URLs and configuration paths below are intentionally
retained; the rebrand does not rename or reprovision infrastructure.

## Provisioned items

- Workspace: `MatchLens Live` (`06c5afed-91fc-4e5b-938a-74637e914cf7`)
- Capacity: Fabric TRIAL (`5b8534f0-4a8d-4730-b160-c486ac6e5ca7`)
- Eventhouse: `matchlens-eventhouse` (`244b90c6-eea9-4475-968c-423e9c976a3a`)
- KQL database: `matchlens-eventhouse` (`db65854b-31de-42e6-a5d4-2698ab8729f4`)
- Query URI: `https://trd-n10gcq57c905n9xjj7.z4.kusto.fabric.microsoft.com`
- Eventstream: `matchlens-live` (`8318447f-47c5-4b9b-8e18-1cac55d85521`)
- Eventstream source: `matchlens-feed-in` (`d8369dfb-0d49-4b2b-9d37-c26a971b0fb4`)
- Eventstream destination: `matchlens-app-out` (`21f22e64-d0e9-456b-9371-55af51422a85`)

## Architecture

```text
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
```

## Rerun

```powershell
pwsh -File scripts/provision-fabric.ps1
npx tsx scripts/eventstream-smoke.ts
npx tsx scripts/load-archive-fabric.ts
```

## Producer KQL examples

```kusto
LiveTimeline("smoke-123")
LiveScore("smoke-123")
HeadToHead("club-rivergate", "club-northbridge")
PlayerCareer("per-rivergate-milo-hart")
FamilyLinks("per-legend-cassian-arden")
FinalsBetween("club-rivergate", "club-northbridge")
```

## Archive load counts

- Clubs: 6
- HistoricGoals: 36
- HistoricMatches: 12
- Honours: 17
- People: 86
- Relations: 10

## Fabric data agent

- Status: Exists
- Item ID: f838b00f-371e-463d-a414-cbf8a33c48a7

## Connection material

Secrets were written to `fabric/.secrets.local.json` only. No connection strings are recorded here.

## Teardown

Delete the **MatchLens Live** workspace to remove every provisioned Fabric artifact in one step.

