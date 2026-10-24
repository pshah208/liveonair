# Backend engineer learnings

## Active
- [work] 2026-10-23 Live pause is control-plane only. Do not add a pause envelope kind: the Eventstream zod schema drops unknown kinds. Freeze the match second, clear publish timers, and resume by rescheduling unpublished feed-plan entries from that second. Mark published per plan entry, not by id@revision, or stress duplicates never publish.
- [mistake] 2026-10-23 The match clock and the 5 Hz tracking projector both derive time from wall elapsed times speed. Subtract accumulated pause from the service clock, and reset the projector origin on the first tick after resume. Set matchStartReceivedAt from the service clock, not transport Date.now(), so an injected scheduler and the pause offset share one timeline. Progressive sessions must not start that wall ticker.
- [work] 2026-10-23 Producer auth already normalises case and trailing slash. New live routes still have to be on the studio allowlist and behind requireStudioToken, same as stop. Eventstream consumers start at enqueuedOn now and do not replay by match wall time, so both transports pause by simply not publishing.

- [mistake] 2026-10-23: An event-loop probe run alongside the test suite gave contaminated numbers. Run event-loop probes on their own.
- [work] 2026-10-23: Full-time stalls came from the per-event chance and metrics recompute (shared/chanceSequence.ts, shared/metrics.ts), not the tracking build. Profile before guessing.
- [mistake] 2026-10-23: The async catch-up warmer in server/live/tracking.ts had no watermark cap, so restarting the same fixture let a stale warmer build past received events (live drifted 59 m from replay). Re-read the watermark in every async chunk. (QA found it; Richard fixed it in 72fdbc5.)
