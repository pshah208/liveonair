# Backend engineer learnings

## Active
- [work] 2026-10-23 Live pause is control-plane only. Do not add a pause envelope kind: the Eventstream zod schema drops unknown kinds. Freeze the match second, clear publish timers, and resume by rescheduling unpublished feed-plan entries from that second. Mark published per plan entry, not by id@revision, or stress duplicates never publish.
- [mistake] 2026-10-23 The match clock and the 5 Hz tracking projector both derive time from wall elapsed times speed. Subtract accumulated pause from the service clock, and reset the projector origin on the first tick after resume. Set matchStartReceivedAt from the service clock, not transport Date.now(), so an injected scheduler and the pause offset share one timeline. Progressive sessions must not start that wall ticker.
- [work] 2026-10-23 Producer auth already normalises case and trailing slash. New live routes still have to be on the studio allowlist and behind requireStudioToken, same as stop. Eventstream consumers start at enqueuedOn now and do not replay by match wall time, so both transports pause by simply not publishing.
