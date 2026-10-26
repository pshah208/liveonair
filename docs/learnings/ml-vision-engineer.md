# ML and vision engineer learnings

## Active
- [work] 2026-10-26 v0.16.8 shipped as rev liveonair--0000026 (image matchlens:v0-16-8-28f9799, ACR run ch1g, 2m47s). It was healthy within 30 s. The 0.16.7 bundle already contained "Social Media Posts" (post-match), so a bare grep proves nothing. Prove the move by absence instead: the `fan-p2-whistle` and "After the whistle" counts went from 1 (live 0.16.7) to 0. For UI moves, baseline the discriminator on the live bundle before deploying.
- [mistake] 2026-10-26 The HQ permission guard rejects shell calls where Azure CLI scope comes from PowerShell variables, or where Azure CLI text appears inside a string (even in a learnings note). Write the literal subscription and resource-group flags on each Azure CLI line, run one Azure CLI command per tool call, and edit notes with the edit tool.
- [work] 2026-10-26 `npm run build` writes the client bundle to dist/client/assets/, not dist/assets/.
- [mistake] 2026-10-23 Windows Azure CLI `az acr build` can exit with a cp1252 UnicodeEncodeError when Vite prints a checkmark, while the remote build continues. Setting `PYTHONIOENCODING=utf-8` did not prevent this on 2026-10-24. Keep the queued run ID and poll `az acr task list-runs` for `Succeeded`; do not submit the image build twice.
- [work] 2026-10-24 The live snapshot SSE endpoint `/api/live/stream` requires `role`, `persona`, and `language` query parameters; a bare request returns HTTP 400. Three simultaneous fan streams with these parameters each received snapshots during the v0.16.3 deployment check.

## Retired
