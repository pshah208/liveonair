# Timed overlay contract

Broadcast graphics read a small public payload. It is not the Storyline Desk document and it does not include player identity tags.

`playerTags` is not part of this contract. The Player ID feature is removed. Do not add it back to the overlay.

## Endpoints

Both are public GET routes. They do not require `STUDIO_TOKEN`.

- `GET /api/overlay/current` — one JSON document.
- `GET /api/overlay/stream` — Server-Sent Events. Each message is `data: <same JSON>\n\n`. A comment heartbeat is sent every 15 seconds. The stream also emits when the live match, clock or desk changes.

## Document

`schema` is `live-on-air.overlay/1`.

```json
{
  "schema": "live-on-air.overlay/1",
  "generatedAt": "2026-07-27T12:00:00.000Z",
  "holdSeconds": 20,
  "match": null,
  "lowerThird": null
}
```

`match` is null when nothing is on air. Otherwise:

| Field | Meaning |
| --- | --- |
| `matchId`, `fixtureId`, `title` | Current live view. |
| `state` | `idle`, `running` or `finished`. |
| `clockSecond`, `minute`, `second` | Match clock. `minute` and `second` are the clock split, not the event minute. |
| `score.home`, `score.away` | Latest non-rescinded goals only. |
| `home`, `away` | `name` and `shortName` only. |

`lowerThird` is the single approved storyline whose clock is inside `[triggerMinute * 60, triggerMinute * 60 + holdSeconds)`. Hold is 20 seconds. A higher `priority`, then a later `updatedAt`, wins if more than one is inside the window. Any other desk status is omitted.

| Field | Meaning |
| --- | --- |
| `storylineId`, `version`, `status` | `status` is always `approved`. |
| `minute` | Storyline trigger minute. |
| `validFromSecond`, `validUntilSecond` | Inclusive start, exclusive end. |
| `headline`, `overlay`, `onAirLine` | Localised strings already approved by a producer. |
| `claimSources` | `{ type: "event" \| "archive", id }` from the storyline claims. |

No player roster, no `playerTags`, and no unapproved copy.
