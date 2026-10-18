# Chance sequence and event-derived territory

Metric version: `chance-sequence/1`. Implemented in `shared/chanceSequence.ts`. These figures are inferred from the event log. They are not provider possession chains, not ball-in-play time, and not a pressure or momentum model.

## Chance sequence

A chance is the latest non-rescinded revision of a `shot` or `goal`.

Walk backward through latest-revision, non-rescinded events at or before the chance. Same-second events keep feed order: the first array index of that event id, not an id sort. A later revision does not move the event. Include same-team on-ball actions: pass (any outcome), shot, goal, save, corner, and a tackle only when `outcome` is `success`. Skip pressure and unsuccessful tackles. They do not break the chain.

Stop without including the boundary event when the walk hits:

- an opponent on-ball action (`turnover`)
- a restart or stoppage from either team: kickoff, halftime, fulltime, foul, yellow card, red card, substitution (`stoppage`)
- a match-clock gap greater than 15 seconds between consecutive included actions (`time_gap`)

A same-team corner is included as the origin and ends the walk (`corner_origin`). Earlier open play is not part of that set piece. The cap is 10 actions including the chance (`action_cap`). Reaching the start of the log is `match_start`.

Precedence while walking backward: stoppage, then opponent on-ball, then time gap, then the action cap, then include. A corner stops after it is included.

Origin zone uses the logged start coordinates in the team's attacking frame (x = 100 is the goal attacked): defensive x < 33.3, middle 33.3 <= x < 66.7, final x >= 66.7. Corners are not moved to the flag.

Progression metres is `((chance.x - origin.x) / 100) * 105`, rounded to 0.1 m. It is the change in attacking-frame x, not the sum of pass lengths. It is null on camera fixtures (`id` starts with `video-`).

`matchClockSpanSeconds` is chance clock minus origin clock. It is match-clock span, not ball-in-play time.

`inferred` is always true. Boundaries come from event order, not provider possession ids.

## Event-derived territory

Never label this possession or pressure.

The current window is the 10 minutes of match clock before the chance, `[chanceSecond - 600, chanceSecond)`. The previous window is the equal span immediately before that. Both clamp at 0. The chance event is excluded. Events that share the chance's exact second are outside the window.

- Final-third entry: a completed pass with `endX` that starts before x 66.7 and ends at or after 66.7.
- Completed pass ending in the final third: completed pass with `endX >= 66.7`.
- If any completed pass in that window lacks `endX`, both of those counts are null. `passesMissingEndX` records how many were excluded. Do not publish a partial total.
- Attacking actions are pass, shot, goal and corner. The final-third share is how many start at x >= 66.7, over how many were recorded. Share is null when the denominator is 0. It is a share of recorded actions, not a possession percentage.

Change is current count minus previous count. It is null when either side is null. There is no probability and no momentum score.

## Insight lifecycle

`insightId` is `chance:<shotEventId>` and stays stable. A new chance is `issued` at revision 1. A contributing event revision change, or a change in the sequence or territory fingerprint, sets `revised` and increments revision. A rescinded or removed shot or goal is `withdrawn` and stays in the list so clients can drop it. Restoring the chance issues a further `revised` revision.

Storylines for a shot or goal store `insightId`. Withdrawal retracts linked storylines and their facts. A revision of an approved storyline moves it back to review. Producer copy may use chance numbers only when a verified `chance_sequence` claim states them.

## Limitations

- Chains are inferred. A missed event, a late revision, or a provider that logs off-ball actions differently will change the boundary.
- The 15-second gap and the 10-action cap are product rules, not a possession model.
- Match-clock span includes stoppages that were not logged as their own events.
- Territory counts only recorded actions. A quiet team can look territorial because the other team is absent from the log.
- Missing `endX` nulls entry and ending-pass counts for the whole window.
- Camera-frame fixtures have no metric progression.
- Evidence lists are capped at 40 events.
- This is not xG, pressure, field tilt, or possession.
