# ML and vision engineer learnings

## Active
- [mistake] 2026-10-23 Windows Azure CLI `az acr build` can exit with a cp1252 UnicodeEncodeError when Vite prints a checkmark, while the remote build continues. Setting `PYTHONIOENCODING=utf-8` did not prevent this on 2026-10-24. Keep the queued run ID and poll `az acr task list-runs` for `Succeeded`; do not submit the image build twice.
- [work] 2026-10-24 The live snapshot SSE endpoint `/api/live/stream` requires `role`, `persona`, and `language` query parameters; a bare request returns HTTP 400. Three simultaneous fan streams with these parameters each received snapshots during the v0.16.3 deployment check.

## Retired
