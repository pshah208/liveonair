# Opta-style ingestion (synthetic)

This adapter parses **synthetic** F24-like JSON so the live service can be exercised without a licensed feed. It is not a Stats Perform integration.

A real Opta / Stats Perform feed requires a **Stats Perform licence**. The type and qualifier ids below are **community-sourced and unverified** against the gated specification. Do not treat them as an official mapping. Ids in the 9000 range are MatchLens synthetic extensions and are not Opta identifiers.

Every synthetic fixture must carry the label `Opta-style format, synthetic data`.

## Configuration

| Env | Values | Default | Effect |
| --- | --- | --- | --- |
| `LIVE_SOURCE` | `canonical`, `opta-format` | `canonical` | `opta-format` round-trips generator events through this adapter before publish. Envelopes are tagged `source: "opta-format-synthetic"`. |
| `EVENTSTREAM_*` | connection strings | unset | Unset uses the local bus. A failed Eventstream publish falls back to local at runtime. |

Video and vision events do not pass through this adapter. They are tagged `source: "video-vision"` when they enter the live service.

The mapping table lives in one place: `server/ingest/opta/mapping.ts`.

## Type ids

| typeId | Canonical | Notes |
| --- | --- | --- |
| 1 | `pass` | Qualifiers 140 and 141 are the pass end, 0–100, in the fixed frame. |
| 7 | `tackle` | |
| 10 | `save` | |
| 13 | `shot` | Outcome `miss`. |
| 14 | `shot` | Outcome `blocked` (closest public stand-in for a blocked shot). |
| 15 | `shot` | Outcome `saved`. A synthetic outcome qualifier restores `success` on the generator round trip. |
| 16 | `goal` | |
| 17 | card | Qualifier 31 yellow, 32 second yellow (`red_card`), 33 straight red (`red_card`). |
| 18 / 19 | `substitution` | Off / on. The canonical model has one substitution type. |
| 43 | deletion | Qualifier 55 is the related event id. Mapped to the existing correction (rescission) flow. |
| 9101 | `pressure` | **No public Opta equivalent.** Requires qualifier 9100 = `synthetic-extension:pressure`. |
| 9102–9106 | corner, foul, kickoff, halftime, fulltime | Synthetic extensions so generator events survive the round trip. |

Unknown type ids are ignored and logged. They are not published.

## Coordinates

Normalisation happens only at ingestion.

- Opta-style `x` and `y` are on a 0–100 grid.
- Canonical events use the attacking frame: `x = 100` is the goal being attacked.
- Period 1: home attacks toward high x, away toward low x. Period 2 switches ends.
- The mirror flips both x and y and is an involution, so the same function converts both ways.
- Qualifiers 140 and 141 are end coordinates in the fixed frame, not the attacking frame.

## Provenance

Published envelopes may include `source`:

- `synthetic` — current generator path
- `opta-format-synthetic` — generator output after this adapter
- `video-vision` — progressive / vision pipeline

`/api/live/status` reports the active source.
