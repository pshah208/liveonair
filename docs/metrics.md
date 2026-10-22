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

---

## Additional synthetic / illustrative metrics

These are synthetic/illustrative figures for hackathon demo data. They are not calibrated to licensed provider models.

### Illustrative xG (location-only)

- Module: `shared/xg.ts`
- Function: `illustrativeXg(x, y)`
- Frame: 0–100 attacking coordinates (`x=100` is the attacked goal, `y=50` is centre).
- Pitch mapping: `x_m=(x/100)*105`, `y_m=(y/100)*68`.
- Formula:
  - `p = clamp(sigmoid(-1.15 - 0.08*d + 1.2*theta), 0.01, 0.60)`
  - `d`: distance (metres) to goal centre
  - `theta`: goal-mouth angle (radians) from shot point to both posts
- Usage: generated shots set `xg` from this function. Outcome does not change the estimate.
- Big/high chance threshold: `HIGH_XG_SHOT_THRESHOLD = 0.30` (`shared/xg.ts`).

### xG assisted (inferred creator)

- Surface label: **xG assisted (inferred creator)**.
- Definition: sum of shot xG for shots attributed to a creator pass/corner link:
  - explicit `relatedEventId` pass/corner to shot; else
  - latest completed same-team pass by another player within 15 seconds, without crossing halftime.
- Synthetic inference, not provider xA.

### Progressive passes

- Rule used: **common 25%-closer-to-goal heuristic** (illustrative implementation).
- Completed pass is progressive when end distance to goal centre is at least 25% lower than start distance.
- Distance is measured in metres on a 105 × 68 m pitch.
- Function: `isProgressivePass` in `shared/metrics.ts`.

### Pass difficulty (illustrative, uncalibrated)

- Formula in `shared/metrics.ts` (`PASS_DIFFICULTY_FORMULA`) is illustrative/uncalibrated.
- Pressure bonus (+15) is applied only for **matched pressure**:
  - opponent pressure event
  - within 0–2 seconds before the pass
  - within 5 metres of the pass start
  - not rescinded
  - if `relatedEventId` is present, it must match the pass id.

### Attacking-threat momentum chart (illustrative)

- Module: `shared/momentum.ts`
- Function: `computeMomentum(events, opts?)`
- Per-minute home vs away threat from:
  - completed pass/carry location-threat proxy (xG surface delta) on an illustrative 12×8 grid derived from `illustrativeXg` by cell centre
  - shots contribute their `illustrativeXg`
- Output:
  - smoothed per-minute net (`home - away`, ~3-minute smoothing default)
  - goal/substitution markers by minute
  - period split (first/second half)
  - `insufficientCoverage` when fewer than 1.2 on-ball events per **observed** minute
    (through the last open event) are available; the chart's 90-minute padding does not
    count as elapsed play. An empty feed is insufficient. The live UI independently
    measures coverage through its current clock minute.

### Control vs chaos windows (illustrative)

- Module: `shared/momentum.ts`
- Function: `controlVsChaos(events, windowMinutes=5)`
- Inputs are latest non-rescinded events in non-overlapping match-clock windows (five minutes
  by default). On-ball events are passes, shots, goals, saves, corners and tackles; pressure
  events are excluded from possession switches. Consecutive on-ball actions by different
  teams count as one **inferred team switch** (`possessionChanges`, count). This is not
  provider possession data, and runs may be truncated at window edges.
- `turnoverRate` (unitless share) = inferred team switches / (`onBall` count - 1);
  null with fewer than two actions. `avgSequenceLength` (recorded actions per inferred
  same-team run) = on-ball count / (switches + 1); null with no actions. Neither quantity
  estimates actual ball-in-play time or a true possession sequence.
- Completed-pass share (unitless) = completed passes / recorded passes; null with no passes.
  Shots are recorded `shot` actions (count), not goals or saves.
- **Full-detail rule** (at least 20 on-ball actions): `chaotic` if turnover rate is at
  least 0.28, or at least three shots **and** turnover rate at least 0.26.
  Otherwise `controlled` if completed-pass share is at least 0.80, at least four passes
  were logged, and turnover rate is at most 0.235. Otherwise `mixed`.
- **Low-detail rule** (`lowDetail=true`, 6–19 on-ball actions): `chaotic` only if at
  least three shots **and** turnover rate at least 0.40. Otherwise `controlled`
  only if at least four passes, completed-pass share at least 0.80 and turnover
  rate at most 0.25. Otherwise `mixed`. This conservative fallback cannot infer
  sustained possession from sparse, potentially selected events.
- Fewer than six on-ball actions sets `insufficientCoverage=true`: the computed label
  is provisional and the UI hides it. The six-action floor is an illustrative product
  rule, not a statistically validated minimum; low-detail readings should be interpreted
  cautiously. Windows beyond observed live play remain insufficient.
- Includes matched pressure-event count and its difference from the preceding window
  (unit: events); it does not change the label.
- **Reference:** illustrative implementation and coverage tests in
  `shared/momentum.ts` and `tests/momentum.test.ts`. These thresholds are heuristic,
  not calibrated to a licensed tracking or event provider and not a validated
  top-flight benchmark.

### UI notes: momentum, control vs chaos, why it matters

- View helpers live in `src/momentumView.ts` (pure, tested in `tests/momentum-ui.test.ts`).
  - `momentumUpTo(events, uptoMinute)` trims the series to the live minute, re-smooths without the empty future (the data layer pads to 90 minutes), and judges coverage over the elapsed minutes only: fewer than 3 minutes played, or fewer than 1.2 on-ball events per elapsed minute, shows "Not enough match events yet". Sparse uploaded-video feeds land here.
  - `latestControlWindow(events, uptoMinute)` picks the latest **completed** five-minute window.
- `src/MomentumChart.tsx` draws home above / away below the zero line, labelled "Illustrative attacking threat (synthetic)", with goal (G) and substitution (V) markers and a half-time divider. Away is always hatched as well as coloured. Team colours that are too close, or a red/green pair, fall back to Okabe–Ito blue `#0072B2` / orange `#E69F00`. Screen readers get an `aria-label` summary and a visually hidden table of clear spells. Transitions are off under `prefers-reduced-motion`.
- `src/ControlChaosCard.tsx` shows the latest window as Controlled / Chaotic / Mixed passage with completed-pass share, possession changes, shots and the change in pressing actions.
- `src/WhyItMatters.tsx` builds the one-line "why it matters" chip deterministically (no LLM). Momentum: a side is "on top" when it holds a share lead of at least 0.35 of the last five minutes' raw threat (and the combined threat is at least 0.1); otherwise "evenly balanced". Control vs chaos: the window label plus the evidence. Every number in the line carries its unit or is a minute mark. Authors: "Match analyst" (momentum), "Tactics analyst" (control vs chaos).
- Studio Desk also shows "Second-screen engagement (simulated)": opt-ins, average minutes engaged and drop-off at goals, half-time and full time, generated from a hash of the match ID. Labelled "Simulated — no real users"; there are no real users and no tracking. An optional "Momentum segment presented by Northwind Sports" label uses a fictional brand.
