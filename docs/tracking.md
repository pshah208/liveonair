# Synthetic live tracking (hackathon)

The live board can show a **synthetic positional layer** (22 players + ball) from `GET /api/live/tracking/stream`.

- It is generated from seeded event coordinates and formation heuristics.
- It is deterministic for a fixture seed and clock second.
- It is strictly for demo storytelling and motion context.

## Limits

- This stream is **not optical tracking** and must not be treated as measured off-ball truth.
- Video/vision matches expose a clear **events-only** state (`no positional data`).
- Real production tracking requires a licensed optical feed (for example TRACAB/Second Spectrum/SkillCorner or equivalent). Event feeds such as Opta events do not include full off-ball trajectories.
