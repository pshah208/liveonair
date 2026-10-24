# Team learnings (shared)

## Active
- [mistake] 2026-10-22 Events are stored in each team's own attacking frame. Any cross-team distance, such as pressure to pass, must mirror one side. A generator and a metric agreeing with each other is not proof; test through the Opta adapter round trip. (data-engineer, match-analyst)
- [mistake] 2026-10-22 Express matches routes case-insensitively and ignores trailing slashes. Auth path allowlists must normalise both, and guards belong on the producer routers themselves. Mount order matters. (backend-engineer)
- [work] 2026-10-22 EventSource cannot send Authorization headers, and Container Apps HTTP logs record query strings. Never put long-lived tokens in URLs; use the single-use 60 s ticket from POST /api/studio/stream-ticket. (backend-engineer)
- [work] 2026-10-22 Absolute per-window thresholds, such as possession changes >= 8, break across data densities. Normalise per on-ball event and add a low-detail fallback. (match-analyst)
- [work] 2026-10-22 ARM what-if cannot resolve Container Apps secrets or env arrays built from @secure params. Verify secrets[].name after deploying as the go/no-go. (platform-architect)
- [mistake] 2026-10-22 The Copilot permission guard rejects Azure CLI calls hidden inside wrapper scripts such as deploy.ps1. Run each step as its own CLI call with an explicit subscription and resource group. Build images from `git archive <sha>` so untracked files stay out. (platform-architect)
- [mistake] 2026-10-22 QA that only reviewed code and tests let saturated 10/10 ratings and stale UI labels ship. QA must run an output-level probe: generate matches across seeds and scenarios, then check the ratings, the counts and the label text. Labels and hints come from shared constants. (qa-reviewer, match-analyst)
- [mistake] 2026-10-22 A new kind of action needs its own canonical EventType, never an existing type plus ID text. Every runtime schema (zod in server/live/transport.ts) is derived from the shared EVENT_TYPES constant; otherwise Eventstream silently drops the events in production. (data-engineer, backend-engineer)
- [mistake] 2026-10-22 Generators delete unwanted goals rather than rescinding them. Highlights, Fan View and Opta all read rescinded goals as "ruled out". Assert the final score and the goal order against each scenario description. (data-engineer)
- [work] 2026-10-22 From v0.15, /api/live/status reports the transport as "eventstream" or "local" (the fallback wrapper), not "fabric-eventstream". (platform-architect)

## 2026-10-23 (v0.16.0 movement + pause/resume)
- [mistake] `live.current()` deep-clones the view, so identity (WeakMap) caches always miss. Key caches on stable ids + roster/team names, and benchmark the real live call path.
- [mistake] Live tracking frames must never revise frames already sent. Bound the horizon by a received-event watermark (`publishedThroughSecond`), not the wall-clock ticker.
- [mistake] Position clamps applied after the velocity/accel limiter reintroduce teleports. Limit targets instead, and measure speed/accel from emitted frames across >=4 scenarios.
- [work] The generator previously chained passes to x>=95; check the event-coordinate spread before tuning anything spatial. Replay-equality tests need a fresh cache key.
- [work] QA rounds of 25-60 min, repeated, cost ~8h on this feature. Time-box QA (10-15 min, in-process probes) and run full-match server runs only once, before deploy.

- [work] 2026-10-23: The HQ deployment desk can mistake the deploy request it is rerouting for a deployment already running. If the backup deployer reports an overlap, check list_agents and re-brief with 'no other deployment is running'.

- [mistake] 2026-10-24: The deployment-desk false overlap happened again (v0.16.3). The first backup-deployer brief should already say: 'no deployment is running; any desk banner about this version is this request'. Confirmed twice, so it's a candidate to add to AGENTS.md.
