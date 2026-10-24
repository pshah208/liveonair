# Frontend engineer learnings

## Active
- [work] 2026-10-23 Live-board CSS lives in `src/board.css` (imported by `src/main.tsx`), not `styles.css`. Theme colours (`--team-home`, `--team-away`, `--cp-bg`, `--cp-text`) are defined per `:root[data-theme]` in `styles.css`; tests can parse them to assert WCAG contrast.
- [work] 2026-10-23 `trackingHorizon !== null` in `LivePitch` means "tracking on and frames arriving", so you can gate the event layers on it without a new prop. Keep tracking render maths (lerp, snap, crowding, trail) in `src/trackingRender.ts` so `node:test` can import it without React.
- [work] 2026-10-23 For a local visual check: build first, run `PORT=<p> STUDIO_TOKEN='' npx tsx server/index.ts` (it binds 0.0.0.0), then POST `/api/live/start` with `{"generate":{"scenario","seed"},"speed"}` (speed is required). Playwright MCP may only write under the repo root or `.playwright-mcp`, so delete that folder afterwards.
- [work] 2026-10-23 Distance-threshold UI toggles that run on interpolated (rAF) frames need hysteresis or they flicker at the boundary. `crowdedPlayerIds` takes the previous set (hide < 2 m, show > 2.5 m); keep the last result in a ref.
