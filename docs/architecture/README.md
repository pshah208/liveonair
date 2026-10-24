# Live on Air architecture

Scope: the judged deployment in `rg-matchlens-hackathon` (subscription `5d2da101-…`, East US 2),
judging window 2026-10-27 to 2026-11-10. All match data is synthetic.

- [runbook.md](runbook.md): deploy, rollback, smoke test and alert handling during judging.
- [../../fabric/README.md](../../fabric/README.md): Fabric real-time layer and decision D4 (trial end date).

## C4 level 1: system context

```mermaid
C4Context
  title Live on Air: system context
  Person(fan, "Fan", "Fan View on a phone or browser")
  Person(producer, "Producer / judge", "Studio Desk; open by default, optional STUDIO_TOKEN bearer")
  Person(dev, "Developer agent", "VS Code / Copilot via MCP")
  System(loa, "Live on Air", "Synthetic live football broadcast with a multi-agent storyline desk")
  System_Ext(foundry, "Azure AI Foundry", "gpt-4.1-mini deployment and Foundry Agents")
  System_Ext(search, "Azure AI Search", "Archive index and knowledge base")
  System_Ext(fabric, "Microsoft Fabric", "Eventstream and Eventhouse (Trial capacity)")
  System_Ext(monitor, "Azure Monitor", "App Insights, Log Analytics, alerts, budget")
  Rel(fan, loa, "HTTPS, SSE")
  Rel(producer, loa, "HTTPS (bearer token)")
  Rel(dev, loa, "MCP streamable HTTP /mcp")
  Rel(loa, foundry, "Entra ID (managed identity)")
  Rel(loa, search, "Entra ID (managed identity)")
  Rel(loa, fabric, "AMQP: Eventstream custom endpoints (connection strings held as ACA secrets)")
  Rel(loa, monitor, "OpenTelemetry")
```

## C4 level 2: containers

```mermaid
C4Container
  title Live on Air: containers (rg-matchlens-hackathon)
  Person(user, "Fans, producers, judges")
  System_Boundary(rg, "rg-matchlens-hackathon") {
    Container(app, "liveonair", "Azure Container Apps, Node 22 / Express, 1 vCPU / 2 GiB, 1 replica", "SPA, REST, SSE, /mcp, A2A, live bus, storyline desk, Video lab (ffmpeg)")
    Container(acr, "matchlensa6qdu7gsghg3w", "Azure Container Registry (Basic)", "matchlens:<tag> images; AcrPull via managed identity")
    Container(id, "matchlens-app-a6qdu7gsghg3w", "User-assigned managed identity", "Secretless auth to ACR, Foundry, Search")
    Container(ai, "matchlens-ai-a6qdu7gsghg3w", "AI Foundry (AIServices)", "matchlens-narrator deployment, 7 prompt agents, Speech")
    Container(srch, "matchlens-search-a6qdu7gsghg3w", "AI Search (basic, eastus)", "matchlens-archive index")
    Container(appi, "liveonair-insights", "Application Insights (workspace-based)", "Traces, requests, availability test")
    ContainerDb(law, "matchlens-logs-a6qdu7gsghg3w", "Log Analytics (1 GB/day cap)", "ACA console logs and App Insights data")
  }
  System_Ext(fabric, "Fabric: MatchLens Live", "Eventstream matchlens-live, Eventhouse")
  Rel(user, app, "HTTPS")
  Rel(app, acr, "Pull image", "managed identity")
  Rel(app, ai, "Chat, agents, TTS", "managed identity")
  Rel(app, srch, "Archive retrieval", "managed identity")
  Rel(app, fabric, "Publish and consume live events", "Event Hubs protocol")
  Rel(app, appi, "OpenTelemetry")
  Rel(appi, law, "Stores data in")
```

Design constraints:
- **Single replica.** minReplicas = maxReplicas = 1, because live match state, SSE fan-out and desk
  state are in-process. Scaling out would split state. Availability depends on fast restarts and
  the watchdog, not on redundancy.
- **Single revision mode.** Traffic always goes to the latest revision. Rollback means deploying the
  previous image (see the runbook); activating an old revision is not enough.
- **Secretless where Azure allows it.** Foundry, Search and ACR use the managed identity. The only
  secrets are the Eventstream connection strings, the App Insights connection string and
  the optional `STUDIO_TOKEN` (unset by default, so Studio is open), all held as Container Apps secrets and supplied only at deploy time.

## Storyline desk: agent handoffs

Source: `server/desk/coordinator.ts` (transition policy), `server/desk/index.ts` (desk loop and
recovery) and `server/desk/agents/*` (Foundry prompt agents). The deterministic policy defines the
legal moves. The **director** agent picks among them only where there is a real choice. An illegal or
failed director proposal falls back to the policy default and is recorded in the trace.

Legal path: `research → verify → [tactics] → produce → fact_check → (revise → fact_check | localize | needs_review) → done`.

```mermaid
sequenceDiagram
  autonumber
  participant Live as Live bus (Fabric or local)
  participant Desk as Desk coordinator (deterministic policy)
  participant Dir as director
  participant Res as researcher
  participant Ver as verify (deterministic claim check)
  participant Tac as tactics-analyst
  participant Pro as producer
  participant FC as fact-checker
  participant Loc as localizer
  participant Studio as Studio Desk (human)

  Live->>Desk: Match event triggers a storyline
  Desk->>Res: research (tools: trigger context, player profile, relatives, H2H, honours, search_archive)
  Res-->>Desk: Claim proposals with evidence IDs
  Desk->>Ver: verify claims against the event log and archive records
  alt No verified claims
    Ver-->>Desk: failed
  else Verified claims
    Desk->>Dir: Next? allowed = [tactics, produce]
    Dir-->>Desk: Proposal (validated against the policy)
    opt tactics chosen and circuit closed
      Desk->>Tac: Tactical angle from event-derived metrics
      Tac-->>Desk: Tactics note (skip_optional on failure)
    end
    Desk->>Pro: produce headline, on-air line, overlay
    Pro-->>Desk: Draft (guarded: length, names, numbers)
    Desk->>FC: fact_check the draft against verified claims
    alt pass
      Desk->>Loc: localize to es / fr / pt
      Loc-->>Desk: Translations (english_only on failure)
      Desk->>Studio: Storyline ready for approval
    else fail and revisions left
      Desk->>Dir: Next? allowed = [revise, needs_review]
      Dir-->>Desk: revise
      Desk->>Pro: revise with fact-checker feedback
    else revisions exhausted
      Desk->>Studio: needs_review (escalate_review)
    end
  end
  Note over Desk: Step budget and deadline per storyline. Per-agent circuit breaker (3 failures → 60 s open).
```

The **player-analyst** is a separate Foundry agent. It isn't part of the storyline desk: it writes
on-demand player scouting notes for the Studio and Fan View.

## Recovery matrix

Rows marked † depend on backend work in wave 1 (fabric-fallback, studio-auth, watchdog, rate-limit
message). Re-verify them against `server/` before judging.

| Failure | Detection | Automatic behaviour | Operator action |
|---|---|---|---|
| Fabric Eventstream down, or trial expired † | Publish error in transport | Runtime switch to the in-process local bus; `/api/live/status` → `transport: local`; UI badge | None needed for the demo. Record in D4; optionally move the workspace to an F2 capacity |
| Fabric secrets missing at deploy | `deploy.ps1` preflight | Deploy refuses to run | Restore `fabric/.secrets.local.json`, or pass `-AllowLocalTransport` deliberately |
| Foundry 429 / quota † | `classifyError` → `rate_limit` | One retry, then circuit breaker; app-level cap `AI_MAX_REQUESTS_PER_HOUR` (120) returns a clear rate-limit message | Check the Foundry quota; raise capacity on `matchlens-narrator` via IaC |
| Agent timeout / invalid schema | `withTimeout`, Zod | `retry_with_feedback` once, then policy fallback | None |
| Director unavailable | Director error | Deterministic policy default (`decidedBy: policy`) | None |
| Tactics analyst failing | Circuit open | `skip_optional`: storyline continues without tactics | None |
| Localizer failing | Error or guard reject | `english_only`: story ships in English, flagged for review | None |
| Fact-check keeps failing | Revisions exhausted | `escalate_review` → `needs_review` in the Studio | Producer approves or discards |
| AI Search unavailable | Retrieval error | The `search_archive` tool fails for the researcher; claims must rest on other tool data (event log, dossier). *Behaviour not verified end to end.* | Check the search service |
| Container crash / OOM † | ACA restart; `liveonair-restarts`, `liveonair-memory` alerts | ACA restarts the replica (probes on `/api/health`); the demo watchdog (`DEMO_WATCHDOG_MINUTES`=10) restarts an idle demo match | Check the logs; roll back if a new revision is at fault |
| App down / unhealthy | `liveonair-availability` (2 of 3 locations), `liveonair-no-replicas` | Liveness probe restart | Runbook: check the revision, then roll back |
| Bad deploy | Smoke test fails | None (Single revision mode) | Runbook: redeploy the previous image tag with `-SkipBuild` |
| Telemetry dropped | Log Analytics `OverQuota` | None | Daily cap raised to 1 GB; check what is driving the volume |
| Cost runaway | Budget 80% actual / 100% forecast | Notification only | Check the Foundry and Search spend |
| Producer endpoints abused † | Unexpected starts/stops/corrections (Studio is open by default since 2026-10-22, by product decision) | Rate limiters; optional `STUDIO_TOKEN` bearer on producer endpoints | Turn auth on: add the `studio-token` secret and `STUDIO_TOKEN` env (runbook section 4) |
