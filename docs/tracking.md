# Synthetic live tracking (hackathon)

The live board can show a **synthetic positional layer** (22 players + ball) from `GET /api/live/tracking/stream`.

- It is generated from seeded event coordinates and formation heuristics.
- It is deterministic for a fixture seed and clock second.
- A frame at simulation second `t` uses only published event revisions through
  `t + TRACKING_DELAY_SECONDS` (3 seconds). The live presenter therefore shows
  a delayed frame, rather than revising an already emitted one.
- `buildTrackingFrame(fixture, t)` can replay a previously built timestep from
  the forward-only packed timeline. A reconnecting SSE client currently joins
  the latest frame; the HTTP stream does not expose a checkpoint cursor.
- The 5 Hz live SSE producer has a tracking-build latency SLO of p95 ≤ 5 ms,
  verified by the deep-cloned, 90-minute incremental timeline test. On the
  current one-second service clock it may emit repeated positions at 5 Hz;
  message frequency and distinct advancing frames are different measures.
- It is strictly for demo storytelling and motion context.

## Limits

- This stream is **not optical tracking** and must not be treated as measured off-ball truth.
- Video/vision matches expose a clear **events-only** state (`no positional data`).
- Real production tracking requires a licensed optical feed (for example TRACAB/Second Spectrum/SkillCorner or equivalent). Event feeds such as Opta events do not include full off-ball trajectories.
- Event origins can be physically unreachable by their synthetic actor within
  three seconds at the player speed cap of 9.5 m/s. This feed favours bounded
  player motion over teleporting a player onto an implausible event coordinate.
- A second-half kickoff injected into an ongoing simulation cannot force every
  player back into their own half within a 3-second horizon if some are more
  than 28.5 m away. Correct half-time resetting needs an explicit break in the
  fixture clock or event data placing players within reachable distance.
