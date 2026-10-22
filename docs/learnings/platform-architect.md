# Platform architect learnings

## Active
- [work] 2026-10-22 Since 2026-10-22, Studio is open by product decision (rev liveonair--0000016): no STUDIO_TOKEN env, no studio-token secret. deploy.ps1 still reads $env:STUDIO_TOKEN as a fallback, so a stale shell variable silently turns auth back on. Clear it before deploying unless that is the intent.
- [work] 2026-10-22 Order for toggling a Container Apps secret-backed env var. Off: remove the env var (new revision), then `secret remove` (app-level, no new revision). On: `secret set` first, then `--set-env-vars NAME=secretref:name`. Check that no live match is running first; a new revision restarts the in-process live state.
- [work] 2026-10-22 /api/health on image v0-15-0-6de35ce reports version 0.14.3. The image tag is the source of truth for what is deployed, not the version field.
