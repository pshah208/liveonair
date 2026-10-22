# Team learnings (shared)

## Active
- [mistake] 2026-10-22 Events are stored in each team's own attacking frame. Any cross-team distance, such as pressure to pass, must mirror one side. A generator and a metric agreeing with each other is not proof; test through the Opta adapter round trip. (data-engineer, match-analyst)
- [mistake] 2026-10-22 Express matches routes case-insensitively and ignores trailing slashes. Auth path allowlists must normalise both, and guards belong on the producer routers themselves. Mount order matters. (backend-engineer)
- [work] 2026-10-22 EventSource cannot send Authorization headers, and Container Apps HTTP logs record query strings. Never put long-lived tokens in URLs; use the single-use 60 s ticket from POST /api/studio/stream-ticket. (backend-engineer)
- [work] 2026-10-22 Absolute per-window thresholds, such as possession changes >= 8, break across data densities. Normalise per on-ball event and add a low-detail fallback. (match-analyst)
- [work] 2026-10-22 ARM what-if cannot resolve Container Apps secrets or env arrays built from @secure params. Verify secrets[].name after deploying as the go/no-go. (platform-architect)
- [mistake] 2026-10-22 The Copilot permission guard rejects Azure CLI calls hidden inside wrapper scripts such as deploy.ps1. Run each step as its own CLI call with an explicit subscription and resource group. Build images from `git archive <sha>` so untracked files stay out. (platform-architect)
- [work] 2026-10-22 From v0.15, /api/live/status reports the transport as "eventstream" or "local" (the fallback wrapper), not "fabric-eventstream". (platform-architect)
