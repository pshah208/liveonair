Live on Air
===========

**The story behind the score.**

Live on Air is a live match-intelligence studio. It ingests synthetic football events through
Microsoft Fabric, turns them into verified statistics and storylines with Microsoft Foundry agents,
and lets a human producer put approved copy on air as lower-thirds, narrated recaps and an
automatically cut highlight reel, in English, Spanish, French and Brazilian Portuguese.

It is a hackathon application, not a Premier League product or affiliation. All clubs, players,
events and scenarios are fictional.

Live demo: https://liveonair.whiteisland-f5b236ef.eastus2.azurecontainerapps.io

**Legacy technical identifiers:** Live on Air is the product brand. The source folder and npm
package remain ``matchlens``. Existing infrastructure resource names, URLs, deployment and agent
IDs (including the ``MatchLens Live`` Fabric workspace), resource tags, JSON schema names,
storage keys, temporary folder names and API contracts are intentionally unchanged. References
to those legacy identifiers in commands and configuration are not the product's display name.

.. contents::
   :local:
   :depth: 1

What you can do
---------------

The app has three desks, switched at the top of the page:

* **Studio Desk**: the producer studio described below, with four tabs (Live desk, Recap and
  highlights, Video lab, Player cam).
* **Fan View**: a read-only, personalised audience view of the same live match, with the same
  **Live board** (pitch and live stats) as the Studio Desk. See **Fan View** below.
* **VAR Desk** is Phase 2 and is not in the app. The design is kept in `VAR Desk (Phase 2)`_.
* Every view shows a "Synthetic match · fictional · illustrative analytics" badge, and scripted
  scenarios are labelled *staged*. Per-player ID tags are intentionally out of scope.

A collapsible **How Live on Air works** panel at the top of the Studio Desk shows each pipeline stage
with live health.

**Live desk**

* Select a local video in **Choose a video and play**. Playback starts without a full-file upload;
  after rights confirmation, sampled frames upload in bounded batches while analysis publishes
  events through the live transport. The original file remains on your device.
* Start a seeded fixtureor generate a new match (comeback, red card, set piece, late winner,
  goal fest) at up to 60x speed. Events flow through Fabric Eventstream with the measured lag
  shown in the broadcast bar.
* Follow the scorebug, animated pitch, live stats and notable-event feed. The broadcast bar shows
  the transport (``eventstream`` or ``local``) and source reported by ``/api/live/status``.
* The Studio Desk is open by default. A producer token (``STUDIO_TOKEN``) is optional hardening.
  When the server requires one (``GET /api/studio/auth-required``), the Studio Desk shows a token
  field. The token is kept in ``localStorage`` (``liveonair.studioToken``) and sent
  as a bearer token on Studio writes. Fan View never asks for one.
* The live board has two views. **Ball movement** (default) animates the ball through the latest
  events on one pitch frame (home attacks left to right, away coordinates mirrored): solid arrows
  for passes, crosses and shots, dotted lines for the inferred route between logged events, shots
  ending at the goal line or in the net, and **Replay sequence** to watch it again. **Action areas**
  shows where the latest events happened. Video-derived matches use camera-view positions.
* Review the storyline queue. Every storyline shows its verified claims, sources and agent trace.
  Approve, edit or reject it; nothing goes on air without approval.
* Preview the on-air lower-third in English, Spanish, French or Portuguese and export it as timed JSON.
* Rule out any goal (a VAR-style correction). The score, dependent storylines, facts and
  highlight captions are retracted and rebuilt.

**Recap and highlights**

* **Highlight reel**, generated automatically from the verified events and approved storylines,
  in English, Spanish, French or Portuguese:

   - *Video recap*: when the live match has matching local footage, the reel is cut around its
     analyzed events, with storyline captions and a scorebug on top. Video Lab moments reach the
     reel once they are sent to the live desk as producer tags.
  - *Data-rendered*: synthetic matches have no footage, so the reel is an animated pitch with
    scorebug, event trail and captions.
  - *Sound*: broadcast-style commentary. The Foundry commentator writes a spoken line for each
    moment from the verified build-up (passes, shots, saves, score), plus an intro and outro, in the
    reel language, with a full-time outro that names every scorer and red card; Azure AI Speech HD neural voices read it, and the data reel paces itself so no
    line is cut off. Video recaps duck the clip's own audio under each line. Without Azure, the
    browser voice reads the captions. One toggle turns all sound off.
  - Export the reel as WebM with the commentary (and the clip audio for video recaps), or download
    the cut list (JSON plus an ffmpeg script).

* **Narrated recap** in English, Spanish, French or Portuguese, built from the live view so manual corrections
  are reflected. A writer step turns the approved facts into a multi-paragraph match report (result, first and second half, every goal, red card and ruled-out goal, key chances and saves, approved storylines, what it means) in the chosen
  language, with a neural-voice reading to listen to; the grounded claims and evidence stay
  alongside it. Every red card and every producer-approved storyline must appear: a draft that
  leaves one out is rejected and the grounded fact-by-fact recap (which lists them) is used instead.
* **Post-match storylines** (``POST /api/live/storylines/postmatch``) on the Recap tab, also available
  mid-match as the story so far. Three to five titled lines weave the verified feed, synthetic archive
  history (including head coaches) and the synthetic news wire, plus a 150–250 word summary in the
  requested language and optional speech audio. A favourite club or player is placed first when the
  pack supports it. Live web search adds real-world precedent only ("From around the game"); it never
  attributes real news to fictional people. Synthetic wire items stay labelled synthetic. If search is
  off, fails, or yields nothing citable, the copy says "No live web context" and does not invent news.
* **Recap chapters** that link each phase of the match to its storylines.

**Player analysis**

* Squad lists for both teams, ranked by an illustrative activity score or shirt number.
* Per player: heat map and action map of their logged actions (with average position), goals,
  assists, shots, shots on target, illustrative xG, xG assisted (inferred creator), box touches,
  passes completed and accuracy, key passes, passes gaining >= 15 grid units, possession lost, tackles won, pressures, saves, fouls and cards.
* **Illustrative activity score**: a 6.0-based score built from published weights for scoring, chance
  creation, passing, defending, goalkeeping and discipline, with the breakdown shown as bars.
* **Analyst note**: the Foundry ``matchlens-player-analyst`` agent writes a short scouting note in
  any of the four languages. Every number and name is checked against the computed figures; a note
  that invents anything (for example a distance run) is rejected for a rules-based note.
* Without a tracking feed, distance and top speed are shown as needing one: an event feed records
  on-ball actions, not continuous player positions. With synthetic tracking, distance is labelled a
  *synthetic minute aggregate* and top speed a *synthetic peak-speed milestone*. Sprint counts are
  not shown.

**Video lab**

* The pundit's **manual tagging** desk, Hudl style. Watch browser-playable footage with slow motion
  and approximate stepping. Nothing is uploaded. Limits: **15 minutes / 500 MB (500 MiB) / 200
  tagged moments per file**.
* Tag panels by phase: Attacking (goal, shot, header, key pass, assist, cross, through ball, dribble,
  carry), Possession (pass, switch of play, build-up, turnover), Defending (tackle, interception,
  clearance, block, ball recovery, aerial duel, pressing, defensive shape, save), Movement (run in
  behind, overlapping run, counter-attack), Set pieces (corner, free kick, throw-in, penalty) and
  Discipline (foul, offside, yellow card, red card).
* Mark **I/O** ranges, set team (named per clip), players, outcome and notes; filter, review and
  analyse the tagged moments; back up as JSON or CSV.
* **Generate highlights** from the tagged moments (untick any to leave them out). The Recap tab
  plays a reel cut from your own footage with each tag, players and notes on screen, a scorebug
  driven by tagged goals, optional voice-over and WebM export.
**Player cam (beta)**

* A Studio tool for producers to create highlights of a specific player: upload a clip (up to
  15 minutes and 500 MB), click the player you want to feature (or give their shirt number and kit)
  and get a player highlight reel with a spotlight on them,
  in landscape or a vertical 9:16 cut that pans with the player. Nothing is sent to Eventstream.

**Fan View** (``#fan``)

* Follows the match the producer started on the Studio Desk: same score, clock and event
  revisions. Fan View never starts or stops a match; with nothing live it says so and links to
  the Studio Desk. Its own fan stream is open only while the view is visible.
* Preferences, saved in this browser only (versioned, validated; if storage is blocked they apply
  for the session with a notice): language (EN/ES/FR/PT), favourite club, favourite player
  (grouped by team) and its own Full match / 1st half / 2nd half selector. Default: English,
  neutral, full match. Fan View always asks the server for the casual persona; the old
  *View as* persona toggle and **Follow one player** mode were removed, and any stored
  ``persona`` / ``followPlayer`` keys are ignored. A saved favourite who is not in this match is
  shown as "not in this match"; no one is substituted.
* **Live board** (top left): the same board as the Studio Desk (shared ``LiveBoardPanel``): the
  animated pitch, period selector and live stats for the match, scoped to your Fan View period.
  The **Player card** sits directly below it. On the right, **Social Media Posts** come first, then the
  Big moment and Player of the match cards. On narrow screens the order is Live board, Social Media
  Posts, Player card, then the rest.
* **Player card** (below the Live board): a shareable ranking card for your favourite
  player. Each row shows stat, a ranking pill (1st, T-2nd for a joint rank, in EN/ES/FR/PT) and the
  value. Ranks are competition ranks (1, 2, 2, 4) among the players with at least one logged
  action in the match ("among the N players in this match"). Rows follow the player's position
  (GK, defender, midfielder, attacker): goals, shots, shots on target, chances created, passes
  completed, pass accuracy (ranked only from 10 passes), tackles won, saves (keepers), hardest pass
  and top speed (only when the fixture carries synthetic tracking). A stat nobody has yet shows
  "No one yet" instead of a rank. The headline ("The one and only", "Top of the class", "Right in
  the mix", "Quiet but busy", "Their moment is coming") comes from the best ranks. The card
  recomputes live, announces rank changes politely (at most every 10 s), shows the shirt as an
  *Illustrative graphic* and carries a "Synthetic demo data" footer. Without a favourite it
  offers the top three by impact to pick from; if your player isn't playing it shows a labelled
  *Spotlight instead* card. **Save as picture** draws the card to a canvas and shares or downloads
  ``playercard_<playerId>_<matchId>_<minute>.png``.
* **Big moment**: one producer-approved, non-retracted story: goals first, then red cards, then the
  latest, with a mini-map of the linked event. If the shown story is later withdrawn the card says
  "This moment was updated".
* **Player of the match** vote: local to your browser (``liveonair.fan.vote.v1``), top three per team
  by impact, opens at 60' and locks at full time. No tallies and nothing is sent anywhere.
* **My match** (key moments): your club's and player's moments first, while every goal, ruled-out
  goal and red card for both sides is always shown. A favourite club only reorders and marks
  moments; it never changes statistics or facts.
* **Social Media Posts** (top right, beside the Live board): a stream of *synthetic* posts from 14
  **fictional** accounts (fan creators, stats, rival fans, pundit-style, memes, local news,
  fanzines; invented handles, some "verified"). Labelled "Synthetic posts · fictional accounts" (a
  "Synthetic" chip with that tooltip) so a saved screenshot stays labelled. No real names, handles
  or logos, and no links. The stream follows the match clock: pre-match chatter and team news are
  there at kickoff, then the match unfolds with kickoff, half-time and full-time, every goal (with
  game-state wording and own goals), red cards, big chances (xG >= 0.30; "golden" from 0.50), big
  saves, yellows only for a second yellow or from 80', substitutions from 60' (grouped), dominant
  spells and quick doubles, plus reactions 20-90 s after goals, cards and big chances, rival-fan
  banter, hot takes, stat nuggets and form notes. Stats use only events up to the post's own
  second; xG is always labelled "illustrative". A ruled-out goal keeps its post (struck through) and
  gets a quoted correction from the same account once the correction is published. Each post shows
  replies, reposts, likes and views, seeded from the fixture and scaled by account reach and event
  weight, so they are reproducible. **Top** orders the posts already visible by popularity (never
  future ones); **Latest** is newest first. At most 20 posts in a scrollable list. With a favourite
  club, an *All / My team* filter appears. New posts slide in (not with reduced-motion) and are
  announced politely, one at a time. Engine: ``shared/pressBox.ts``.
* **Approved stories** (localised, with English fallback flagged), **What changed since you last
  looked** (new goals, cards, corrections and approved stories since you left the view), in-app
  favourite-player alerts (deduplicated; no push notifications) and **My match summary** (an *AI
  summary* written on demand for your language, club and player, with audio when Azure AI
  Speech is available; always full match). The former *Why it matters* panel and *My moments*
  reel were removed from Fan View, and so was the *Chance build-up* card.
* The fan stream (``/api/live/stream?role=fan``) only carries producer-approved storylines, without
  agent traces, handoffs, review notes or rejected claims, and only the verified facts of approved
  storylines. ``role=fan`` is presentation filtering, **not access control**: the demo's producer
  API is still public (see `Phase 2: path to production`_).

How it works
------------

.. code-block:: text

   Synthetic match feed (MatchLab fixtures and generator)
             |
             v
   Fabric Eventstream ── custom endpoint in ──> Eventhouse (KQL)
             |                                    MatchEventsRaw -> update policy -> MatchEvents
             |                                    synthetic archive: clubs, careers, finals, family links
             v
   Container Apps API ── deterministic match engine (score, stats, xG, story cards, corrections)
             |
             v
   Storyline desk (Microsoft Foundry agents, shared StorylineWorkspace blackboard)
     director        -> picks the next handoff; a deterministic policy enforces legal transitions,
                        step budget and deadline, and falls back when the director is unavailable
     researcher      -> Foundry IQ knowledge base over Azure AI Search (archive)
     verifier        -> deterministic: only claims matched to feed events / archive records survive
     tactics analyst -> optional: engine story cards (pressure, rhythm, turning point...) -> claims
     producer        -> drafts headline, on-air line and overlay from verified claims only
     fact-checker    -> re-checks the draft; revise loop or escalate to human review
     localizer       -> Spanish, French and Portuguese versions (English-only fallback, flagged)
     deterministic guard: rejects names or numbers not in verified claims, retries with feedback
     recovery: timeouts, rate limits, schema errors, guard rejects; per-agent circuit breakers
             |
             v
   Producer approval (human in the loop)  <── handoff timeline + trace in the storyline panel
             |
             v
   Outputs: lower-third JSON · narrated recap · post-match storylines · highlight reel · cut list   (EN / ES / FR / PT)
   External agents: MCP server (/mcp) · A2A agent (/.well-known/agent-card.json, /a2a)

1. **Ingest.** The simulator publishes each event to a Fabric Eventstream custom endpoint.
   Eventstream fans it out to Eventhouse and back to the app over a second custom endpoint.
   Without Eventstream credentials the app uses an in-process bus and says so.
2. **Store.** Eventhouse keeps raw events and a typed ``MatchEvents`` table via a KQL update
   policy, plus the synthetic archive used for historical context.
3. **Interpret.** A deterministic engine recomputes score, rolling statistics, illustrative xG and
   evidence-linked story cards on every event. Only the latest revision of each event counts.
4. **Explain.** On key events the storyline desk runs its Foundry agents under a director.
   Claims are verified deterministically before a producer ever sees them.
   A shot or goal also gets a chance insight: the preceding sequence and event-derived
   territory, recomputed on every event. Definitions and limits are in ``docs/metrics.md``.
5. **Render and personalise.** Approved copy becomes lower-thirds, recaps and
   highlight captions in four languages. Fan and studio streams still carry issued, revised
   and withdrawn insights, but neither desk displays them. Tailored fan copy still waits for producer approval.

Director, handoffs and recovery
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Each storyline run owns a typed ``StorylineWorkspace`` (``server/desk/state.ts``): trigger, claims,
drafts, reviews, localisation, attempt counters, step budget and deadline, and a handoff log.
Agents read from and write to it; the log is persisted on the storyline as ``handoffs``
(``{from, to, reason, at, outcome, decidedBy, recovery, errorClass}``) and shown as a timeline
above the trace in the storyline panel.

* **Coordinator** (``server/desk/coordinator.ts``). The policy allows only
  research → verify → [tactics] → produce → fact-check → (revise → fact-check | localize |
  human review). Where it offers a real choice (tactics-led vs archive-led after verification;
  revise vs escalate after a fact-check), the ``liveonair-director`` Foundry agent proposes the
  next step from a compact workspace summary. An error, timeout, open circuit or illegal proposal
  falls back to the deterministic default and is logged as a ``fallback`` handoff. A step budget
  (12) and deadline (4 minutes) stop the run and send any guard-checked draft to human review.
* **Tactics analyst** (``liveonair-tactics-analyst``). Reads the engine's story cards for the
  15 minutes before the trigger and selects the ones that explain it. Only the events they rest on
  become claims (``live_event``/``match_state``), and only verified claims reach the producer.
* **Recovery** (``server/desk/recovery.ts``). Failures are classified as ``timeout``,
  ``rate_limit``, ``schema_invalid``, ``guard_reject`` or ``unavailable``. Transient failures
  are retried (producer retries carry feedback); the optional tactics analyst is skipped; a
  localizer failure leaves flagged English-only copy; a fact-checker outage escalates the
  guard-checked draft to human review. A per-agent circuit breaker opens after three
  consecutive failures for 60 seconds. Every recovery is a rejected trace step plus a handoff.

Agents for external tools
~~~~~~~~~~~~~~~~~~~~~~~~~

**MCP server.** ``POST /mcp`` is a stateless streamable-HTTP MCP endpoint
(``@modelcontextprotocol/sdk``) with read-only tools: ``get_live_status``,
``get_live_snapshot`` (persona, language, optional ``period``), ``get_event``,
``get_player_stats``, ``get_chance_insights`` (inferred build-up and event-derived territory),
``search_archive`` (Foundry IQ / AI Search, or local keyword search),
``list_storylines`` (approved only unless the caller is authenticated) and ``verify_claim``
(the deterministic verifier). It is rate limited; when ``MCP_TOKEN`` is set every call needs
``Authorization: Bearer <token>`` and may request drafts. VS Code / GitHub Copilot
(``.vscode/mcp.json``):

.. code-block:: json

   {
     "servers": {
       "live-on-air": {
         "type": "http",
         "url": "http://localhost:3000/mcp",
         "headers": { "Authorization": "Bearer ${input:liveOnAirToken}" }
       },
       "live-on-air-local": {
         "type": "stdio",
         "command": "npx",
         "args": ["tsx", "scripts/mcp-stdio.ts"],
         "env": { "MCP_STDIO_FIXTURE": "<fixture-id>" }
       }
     },
     "inputs": [{ "id": "liveOnAirToken", "type": "promptString", "password": true, "description": "MCP_TOKEN" }]
   }

Omit ``headers`` when ``MCP_TOKEN`` is not set. ``scripts/mcp-stdio.ts`` runs the platform
in-process; ``MCP_STDIO_FIXTURE`` optionally starts replaying a fixture so the live tools have data.

**A2A agent.** ``GET /.well-known/agent-card.json`` publishes an A2A Agent Card (protocol 0.3.0)
for the Storyline Desk and ``POST /a2a`` implements JSON-RPC 2.0 ``message/send`` and
``tasks/get``. Send an event ID as a data part (``{"eventId": "..."}``) or in text; the
completed task's artifact holds the storylines that cite it. Unauthenticated callers get
human-approved copy only; ``Authorization: Bearer $A2A_TOKEN`` adds drafts, labelled with their
review status. The endpoint is read-only and rate limited: it never approves anything.

**Telemetry.** With ``APPLICATIONINSIGHTS_CONNECTION_STRING`` set, ``server/telemetry.ts``
starts Azure Monitor OpenTelemetry before Express loads and records a span per storyline, per
agent call and per handoff (attributes ``agent``, ``storylineId``, ``outcome``, ``recovery``).
Without it, telemetry is a no-op.

Highlight reel
~~~~~~~~~~~~~~

``shared/highlights.ts`` ranks verified events: goals, ruled-out goals, red cards, big chances
(xG >= 0.25), key saves (shot xG >= 0.15) and bookings. Video-derived matches have no xG, so every
missed or saved attempt and every save counts. A moment scores higher if an approved
storyline covers it. Goals, ruled-out goals, red cards and moments with an approved storyline are
always included; other moments fill up to eight clips by default. Each gets a time window that starts
before the moment; overlapping windows are merged so no footage repeats, and a red card or approved
moment that shares a window with a bigger one keeps its own line in the caption.Each clip's caption is the approved
storyline overlay in the chosen language, falling back to English (flagged in the UI) or to a
built-in caption.

The same clip list drives every output:

:Video recap: For a video-derived live match with matching local footage, the clip plays in a
              hidden video element and a canvas draws it with the overlays. Video-derived events
              run on the clip's own clock; no manual alignment is needed. Local review annotations
              become recap events only when sent to the desk as producer tags.
:Data-rendered: Canvas animation at 1280x720, recorded to WebM with ``MediaRecorder``.
:Cut list: JSON timecodes plus a bash script that cuts and joins the clips with ffmpeg in an
           edit suite.
:Sound: The Foundry commentator writes one line per clip (``POST /api/live/highlights/commentary``)
        from the events inside the clip window; Azure AI Speech voices each line
        (``en-GB-Ollie``, ``es-ES-Tristan``, ``fr-FR-Remy``, ``pt-BR-Macerio`` HD voices). Lines are mixed through
        Web Audio so they are recorded into exports, and the data reel stretches each hold to
        the line's length. The browser speech engine reads captions when Azure is unavailable.

Synthetic matches have no footage of their own, so their reel is always data-rendered.

Live Desk progressive video
~~~~~~~~~~~~~~~~~~~~~~~~~~~

**Choose a video and play** belongs to Live Desk, not Video Lab. It accepts browser-decodable
MP4, MOV and WebM within the 15-minute / 500 MB limits.
The browser plays a local object URL and samples a separate decoder at fixed timestamps,
sending up to four JPEG frames per batch, with at most two batches pending. Cloud analysis
starts before the remaining frames are uploaded. No full source file is stored in this mode.

Playback can run ahead of analysis. The live match clock represents the analysis watermark;
AI-detected events are provisional observations, not human-confirmed goals. Pausing playback
does not discard queued analysis. Stop/failure preserves partial coverage rather than claiming
the whole video was analyzed. Uploaded/analyzed timestamps, frame counts, pending batches and
errors expose progress. After a stopped or failed session, **Retry live analysis** deliberately
starts the same file from the beginning once no match is running; it is not an automatic restart.

Video Lab: pundit tagging and highlights
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Video Lab is a dedicated workbench for manual tagging. Its state stays mounted across tab switches,
separately from the Live Desk progressive panel; leaving Video Lab pauses its player. It never
uploads footage and never changes the live match.

1. **Watch.** Select a local MP4, MOV or WebM, up to 900 seconds and 524288000 bytes (500 MiB,
   labelled 500 MB). Use play/pause, ±5-second seeks, 0.25x/0.5x slow motion or faster playback.
   Step controls seek approximately 0.04 seconds, not exact video frames. Name the two teams.
2. **Tag.** Pick a tag from the phase panels; it marks 3 seconds before and 5 after the current
   frame, bounded by the source. Adjust in/out with buttons or **I/O**, then save a title, team,
   player tags, observed outcome and notes. Up to 200 moments are allowed.
3. **Review.** Timeline markers and library clips play to their out point. Edit or delete moments.
   Search and filter by team, player, tag and overlapping time window; the timeline, library,
   statistics and CSV use the same filters.
4. **Understand.** Analysis shows tagged shots, goals, passes and defensive actions, team and
   outcome breakdowns, player tag counts and activity by clip start. Counts describe saved tags only.
5. **Generate highlights.** The filtered moments (minus any unticked) become a reel on the Recap
   tab, cut from the same local file on the clip's own clock: tag label, title with players, notes
   as the caption, and a scorebug that only counts goals tagged for a team.
6. **Keep a backup.** Moments and filters are saved in browser local storage keyed by filename,
   size and last-modified time. JSON backup/import and filtered CSV export are available; neither
   contains video.

Storage failures, corrupt saved data or changes from another tab pause automatic saving and
preserve existing storage; export the in-memory review before explicitly replacing saved data.

The server's full-upload video API (``POST /api/video/jobs`` and related endpoints) remains for
programmatic use and tests; the Video Lab UI no longer calls it.
Footage classification and coverage
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Progressive analysis and the full-upload event worker explicitly distinguish ``match``,
``broadcast_graphics`` and ``unsupported`` footage:

* Football broadcast intros, team logos, lineups, title graphics and studio/interstitial coverage
  without match footage are skipped only when explicitly classified as ``broadcast_graphics``.
  Such batches contribute no detections or kit updates; graphics are not goal or player evidence.
* Mixed match/football-graphics batches are classified as match, with instructions to detect
  events and identify kits only from genuine match frames. Unrelated content, test patterns,
  video games, standalone animations, diagrams and screenshots are unsupported. Unsupported
  content in any batch rejects the source rather than being silently skipped.
* Graphics-only input does not fail at the intro: analysis continues looking for match footage.
  If none is found by completion, the progressive session fails and the full-upload job is
  rejected instead of returning a successful empty match.
* Progressive status exposes ``skippedFrames`` and ``coverageNote`` alongside uploaded/analyzed
  watermarks; graphics can advance sampled coverage without producing match events. Full-upload
  job logs record skipped batch coverage and ``footageCheck`` summarizes the result. These are
  sampled coverage signals, not proof that every moment was understood.

Sampled stills can miss quick passes or goals, frame coordinates are not player tracking, and
model player identification relies on legible numbers. Goal investigation and replay recognition
are deferred; guaranteed goal detection and reliable replay filtering are not implemented.
Team sharing, accounts, collaborative comments and drawing overlays are also outside this release.

Player cam (beta)
~~~~~~~~~~~~~~~~~

Player cam reuses the video worker to follow one player instead of tagging match events. It is a
Studio tool for producers creating highlights of a specific player; it never touches Eventstream
or the live desk.

The same 15-minute / 500 MB limit and asynchronous processing apply. Clips of 180 seconds or less
still use at most 60 frames at 1–3 second intervals; longer clips sample approximately every
3 seconds, up to 300 frames in at most 25 sequential batches of 12. Longer clips take longer to
process. The uploaded source is deleted after processing; the reel plays from the local clip.

1. **Identify.** The producer pauses the clip and clicks the player; the shirt number and kit are
   optional extra hints. At least one of the three is required.
2. **Reference.** ffmpeg draws a box round the clicked spot and crops it. Every vision batch gets
   this crop first, so the model matches build and kit, not just a number that is often unreadable.
3. **Find.** For each sampled frame the model returns whether the player is visible, a bounding box,
   what they are doing (shot, header, save, dribble, tackle, pass, on the ball, celebration, off the
   ball) and a confidence.
4. **Build moments.** Code keeps sightings at 50% confidence or more, groups involvement that is
   close in time, pads each moment (2.5 s before, 2 s after, at least 4 s), merges overlaps and
   ranks by action and confidence (top eight). If the player is never involved, it falls back to
   up to three positioning moments.
5. **Reel.** The browser cuts the moments from the local clip and draws a ring at the player's feet
   and a name tag, interpolated between sightings. *Vertical 9:16* pans with the player for phones.
   The producer can untick wrong moments; sound plays the clip audio plus a voice that calls each
   moment; the export includes the clip audio.

Microsoft and Azure services
----------------------------

=================================  ==========================================================
Service                            Use
=================================  ==========================================================
Microsoft Fabric Eventstream       Real-time event ingestion and fan-out
Fabric Eventhouse (KQL)            Event store, update policy, archive, producer KQL functions
Microsoft Foundry Agent Service    Director, researcher, tactics analyst, producer, fact-checker and localizer agents
Foundry IQ and Azure AI Search     Knowledge base over the synthetic archive
Azure OpenAI (gpt-4.1-mini)        Agents, narration, progressive vision and optional Video Lab suggestions
Azure AI Speech (HD neural TTS)    Spoken highlights commentary and recap audio, on the Foundry account
Azure Container Apps               API and studio UI, server-sent events, MCP and A2A endpoints
Azure Container Registry           Image builds (``az acr build``)
Managed identity and RBAC          Keyless access to Foundry, Search and the registry
Log Analytics                      Container logs
Application Insights (optional)    OpenTelemetry spans per agent call and handoff
Bicep and GitHub Actions           Infrastructure as code; CI runs tests, typecheck and build
=================================  ==========================================================

Trust and guardrails
--------------------

* Every claim is matched to feed events or archive records before it reaches a producer.
* Agent copy that adds names or numbers not in its verified claims is rejected and retried.
* Recap prose and spoken commentary are checked the same way: a line that names an unlisted player
  or uses an unlisted number falls back to the verified caption or fact text.
* Nothing goes on air without producer approval. Edits are recorded in the trace.
* A goal correction keeps the original event in the audit trail and retracts dependent output.
  A withdrawn chance insight retracts storylines linked by ``insightId`` or the shot event id.
  A revised insight flags approved copy back to review. Sequence and territory numbers in
  on-air copy must come from a verified ``chance_sequence`` claim.
* Video Lab manual review stays local. Optional full-upload AI requires explicit footage/upload
  permission; Live Desk progressive AI separately requires permission to send sampled frames.
  Full-upload sources are deleted after processing and playback uses the local file.
* Progressive/full-upload event analysis skips explicitly classified football broadcast graphics
  without using detections or kits, rejects unsupported footage and fails completion if no match
  footage was seen. Progressive failures preserve partial coverage, not a claim of full-time
  analysis. Model detections must cite sampled frames; rule-inferred suggestions are labelled.
* When the model is unavailable, AI features say so; there is no hidden mock narration.
* Post-match web search (``NARRATIVE_WEB_SEARCH``, default on only when ``AZURE_OPENAI_ENDPOINT`` is
  set) sends public situation queries to the Azure OpenAI Responses ``web_search`` tool. The Container
  App parameter ``narrativeWebSearch`` is ``on`` or ``off`` and defaults to ``on``. Those queries
  leave the Azure compliance boundary. Only public topics are sent: real-world precedent such as
  comebacks, early red cards, late winners and set pieces. Fictional demo names are not searched.
  A name is searched only when that archive club or adult person is explicitly flagged ``realWorld``.
  A citation is kept only when its URL matches a returned search source exactly. Scheme and host case,
  a trailing slash and a fragment may be normalised; the query string is kept, so a different query or
  a path suffix is rejected. The host must not be a social or user-generated site.
  ``filters.allowed_domains`` is not used: gpt-4.1-mini rejects it. Web snippets are untrusted quoted
  data and are not copied into fallback copy. Generation is cached per match: one scout, one finished
  recap per language and persona, and so-far copy at most once per five minutes of match clock.

Synthetic data and footage policy
---------------------------------

Fixtures and the generator live in ``server/fixtures.ts`` and ``server/matchlab/``. Event
coordinates describe on-ball actions, not continuous tracking. xG values are scenario attributes,
not a trained model.

The hackathon rules (section 4.7) allow footage only when you hold the rights to it. Do not use
downloaded broadcast footage, even with player names changed. Suitable sources are your own
recordings (with the players' consent), CC0 stock clips with no club or league branding, or
synthetic video.

Local setup
-----------

Requires Node.js 22 or later.

.. code-block:: powershell

   npm ci
   npm test
   npm run typecheck
   npm run build
   npm start          # http://localhost:3000

Without Azure configuration the live desk, engine, highlight reel and corrections all work, using
the in-process event bus. Video Lab local playback, tagging, analysis and backups also work without
Azure. Agents, recaps and optional AI detection report missing configuration.

To enable AI and Fabric locally, copy ``.env.example`` to ``.env.local``, fill in the values below,
sign in with ``az login`` and run ``node --env-file=.env.local --import tsx server/index.ts``.

.. list-table::
   :header-rows: 1
   :widths: 45 55

   * - Variable
     - Purpose
   * - ``AZURE_OPENAI_ENDPOINT``, ``AZURE_OPENAI_DEPLOYMENT``
     - Recap narrator and highlights commentator model; the Speech endpoint is derived from it
   * - ``AZURE_SPEECH_ENDPOINT``, ``SPEECH_VOICE_EN``/``_ES``/``_FR``
     - Optional Speech endpoint and voice overrides
   * - ``PROJECT_ENDPOINT``
     - Foundry project for the storyline agents
   * - ``AZURE_SEARCH_ENDPOINT``, ``AZURE_SEARCH_INDEX``, ``AZURE_SEARCH_KNOWLEDGE_BASE``,
       ``AZURE_SEARCH_KNOWLEDGE_SOURCE``
     - Archive retrieval (Foundry IQ knowledge base)
   * - ``EVENTSTREAM_SOURCE_CONNECTION_STRING``
     - Publish to Fabric Eventstream (optional)
   * - ``EVENTSTREAM_DESTINATION_CONNECTION_STRING``
     - Consume from Fabric Eventstream (optional)
   * - ``AZURE_SUBSCRIPTION_ID`` or ``AZURE_TENANT_ID``
     - Pin Azure CLI credentials locally
   * - ``MCP_TOKEN``
     - Optional bearer token required on ``/mcp``; also unlocks draft storylines
   * - ``A2A_TOKEN``
     - Optional bearer token that lets A2A callers see drafts (approved copy is always public)
   * - ``APPLICATIONINSIGHTS_CONNECTION_STRING``
     - Optional Azure Monitor OpenTelemetry export (``appInsightsConnectionString`` in ``infra/app.bicep``)

Do not run locally with the deployed app's Eventstream credentials; both instances would share
one stream. Never commit ``.env.local`` or ``fabric/.secrets.local.json``.

Provisioning
------------

.. code-block:: powershell

   # Azure: Foundry, model, Search, registry, Container Apps
   .\scripts\deploy.ps1 -SubscriptionId "<subscription-guid>" -ResourceGroup "rg-matchlens-hackathon"

   # Foundry agents (incl. liveonair-director and liveonair-tactics-analyst) and the Foundry IQ knowledge base
   node --env-file=.env.local --import tsx scripts/provision-desk.ts

   # Fabric workspace, Eventhouse, Eventstream and archive
   pwsh -File scripts/provision-fabric.ps1
   npx tsx scripts/load-archive-fabric.ts
   npx tsx scripts/eventstream-smoke.ts

   # App-only update
   .\scripts\deploy.ps1 -SubscriptionId "<subscription-guid>" -ImageTag v0-7-0 -UseExistingInfrastructure

``deploy.ps1`` reads ``fabric/.secrets.local.json`` and stores the Eventstream connection strings
as Container Apps secrets. Re-running ``provision-fabric.ps1`` rotates those endpoints, so redeploy
the app afterwards. See ``fabric/README.md`` for the Fabric items and example KQL.

API
---

.. list-table::
   :header-rows: 1
   :widths: 45 55

   * - Endpoint
     - Purpose
   * - ``GET /api/health``
     - Version and model configuration
   * - ``GET /api/fixtures``, ``GET /api/fixtures/{id}``
     - Seeded fixture catalogue and full event streams
   * - ``POST /api/live/start``
     - Start a fixture or generated match (speed 1 to 60)
   * - ``POST /api/live/stop``
     - Stop the live match
   * - ``POST /api/live/correction``
     - Rule out a goal by event ID
   * - ``GET /api/live/stream``
     - Server-sent events: status, snapshot, storyline, fact, insight, heartbeat
   * - ``GET /api/live/insights``
     - Current chance insights (optional ``role=fan|studio``; both roles see withdrawn)
   * - ``GET /api/live/status``, ``GET /api/live/fixture``
     - Clock, transport and lag; the live view with every event revision
   * - ``POST /api/live/narrate``
     - Recap of the live view (persona and language), with ``audioUrl``
   * - ``POST /api/live/storylines/postmatch``
     - 3–5 grounded storylines plus a summary. Body: language, persona, optional favourite club/player. Running matches are "so far"; finished matches are post-match. ``webContext.label`` is "No live web context" when live search was not used.
   * - ``POST /api/live/highlights/commentary``
     - Spoken commentary for the reel's clips (language, clip windows), with audio URLs
   * - ``GET /api/audio/{id}.mp3``
     - Neural-voice audio for server-generated recap and commentary text only
   * - ``GET /api/studio/storylines``
     - Storyline queue with claims, traces and handoff logs
   * - ``POST /mcp``
     - Read-only MCP tools (streamable HTTP, stateless)
   * - ``GET /.well-known/agent-card.json``, ``POST /a2a``
     - A2A Agent Card; JSON-RPC ``message/send`` and ``tasks/get`` for storylines by event
   * - ``POST /api/studio/storylines/{id}/review``
     - ``approve``, ``edit`` or ``reject``
   * - ``GET /api/studio/facts``, ``GET /api/studio/storyboard``
     - Verified facts; recap chapters
   * - ``GET /api/archive/summary``, ``/players/{id}``, ``/export``
     - Synthetic archive
   * - ``GET /api/video/health``
     - Worker availability (``visionConfigured``, ``ffmpeg``) and shared limits: ``maxUploadBytes`` (524288000), ``maxVideoSeconds`` (900), ``maxFrames`` (300)
   * - ``POST /api/video/live-sessions``
     - Start progressive analysis with source metadata, teams/kits and rights confirmation; no source-file upload
   * - ``POST /api/video/live-sessions/{id}/batches``
     - Upload up to four sequential sampled JPEGs; returns ``202`` before inference finishes, or ``429`` for backpressure
   * - ``GET /api/video/live-sessions/{id}``
      - Uploaded/analyzed watermarks, skipped frames and coverage note, partial events, evidence, live status and errors
   * - ``POST /api/video/live-sessions/{id}/complete``, ``DELETE /api/video/live-sessions/{id}``
     - Finish after all planned frames are received and analyzed, or stop while preserving partial coverage
   * - ``POST /api/video/jobs``
     - Upload a clip (raw MP4, MOV or WebM body, at most 500 MB and 15 minutes; team names and kits as query parameters); returns ``202`` with a job to poll
   * - ``GET /api/video/jobs/{id}``, ``/frames/{n}``
      - Worker progress, coverage logs/footage check, detected events with evidence; the exact frame the model saw
   * - ``POST /api/video/jobs/{id}/swap-teams``, ``/live``
      - Supported programmatic controls: flip home/away kits or stream a ready job through the live pipeline; not the main Video Lab UI
   * - ``POST /api/video/jobs/{id}/tags``, ``DELETE .../tags/{tagId}``
      - Add/remove producer event tags (five per job; ``type``, ``team``, ``second``, optional ``shirtNumber`` and ``note``); separate from 200 local review annotations
   * - ``GET /api/video/jobs``, ``DELETE /api/video/jobs/{id}``
     - Clip library, newest first; delete a finished clip with its frames, events, tags and fixture
   * - ``POST /api/player-cam/jobs``
     - Upload a Player cam clip (raw MP4, MOV or WebM body, at most 500 MB and 15 minutes); returns ``202`` with a job to poll. Query ``playerName`` plus at least one of ``number``, ``kit`` or ``anchorSecond``/``anchorX``/``anchorY`` (the click)
   * - ``GET /api/player-cam/jobs``, ``/{id}``, ``/{id}/frames/{n}``, ``/{id}/reference``, ``DELETE /{id}``
     - Library, job with sightings, track and moments, evidence frames, the reference crop, delete

Request and response contracts are in ``shared/types.ts``, ``shared/platform.ts`` and
``shared/video.ts`` / ``shared/progressiveVideo.ts``. API inputs are validated with zod;
bodies, request rates and AI concurrency are bounded. ``shared/videoLab.ts`` defines and validates
the separate browser-local annotations, filters, statistics and JSON backup format.

Testing
-------

``npm test`` runs Node's test runner across the engine, fixtures, live pipeline, storyline desk
(including rate-limit retry and the guard), the coordinator policy, director fallback, circuit
breaker and recovery paths, the MCP tool contract and A2A endpoint, narrator contracts, archive,
API and highlight
selection, including the cut-list time mappings and localisation. CI runs tests, typecheck and the
production build on every push.

Two-minute demo
---------------

1. Open **How Live on Air works** and explain the pipeline. Collapse it.
2. Start the comeback fixture at 60x speed. Point out Fabric transport and lag.
3. Open a storyline: claims, sources, agent trace. Approve it and show the lower-third in Spanish.
4. Rule out a goal. The score, storylines and captions update.
5. Switch to **Fan View**: pick the away club and a player, switch to Spanish, show the player card
   and its ranks, and show the approved story arriving in the fan feed and the Big moment card.
6. Back on the Studio Desk, switch to **Recap and highlights**. Play the reel, switch it to French and export it.
7. Generate a recap in Spanish.

Phase 2: path to production
---------------------------

The design (event stream, Fabric, agents, human approval, cut list) suits a rights holder such
as a league or broadcaster. This build is a single-tenant demo. A pilot would need:

==============================  =========================================  ==========================================
Area                            Today                                      Phase 2
==============================  =========================================  ==========================================
Event source                    Built-in synthetic feed                    Adapter that maps a licensed live data
                                                                           feed into the Live on Air event schema and
                                                                           publishes to Eventstream
Access control                  Public demo, no sign-in                    Microsoft Entra ID with producer, editor
                                                                           and viewer roles
Scale and state                 One match, in memory, one replica          Durable state (Cosmos DB or Redis) and
                                                                           Service Bus; many concurrent matches
Graphics output                 In-app preview and JSON export             Push approved lower-thirds to the
                                                                           broadcaster's graphics engine
Live video                      Recorded file in the browser               Sync overlays to the live programme feed
                                                                           by timecode
Highlights                      WebM export and ffmpeg cut list            Media-asset-management integration and
                                                                           server-side rendering (Container Apps Jobs)
Video auto-eventing             Progressive + optional full-upload         Blob upload, Service Bus queue and a
                                clips, frame sampling and a vision model   Container Apps Job worker (as in
                                                                           PlayerIQ); player tracking for passes
                                                                           and speeds
Languages                       English, Spanish, French, Portuguese       More localizer languages and translated
                                                                           studio UI
Secrets and operations          Container Apps secrets, Log Analytics      Key Vault, alerts, dashboards, budgets
Fabric capacity                 Trial capacity                             Paid F-SKU sized to match-day load
Governance                      Producer approval                          Rights checks for footage and data;
                                                                           responsible-AI review for on-air copy
==============================  =========================================  ==========================================

VAR Desk (Phase 2)
------------------

A second desk that stays idle until a VAR check or review is called in the live feed. It reuses
the Studio Desk pipeline:

1. **Trigger.** A ``var_check`` or ``var_review`` event in Eventstream (or a producer pressing
   Review) wakes the desk.
2. **Clip.** The video worker cuts the seconds around the incident from each licensed angle and
   samples frames.
3. **Read.** A Foundry vision agent describes the incident and cites the frames it used.
4. **Check the Laws.** Foundry IQ retrieves the relevant Law and VAR protocol passages from an Azure
   AI Search index over the current rulebook.
5. **Recommend.** An agent combines both into a cited recommendation with confidence; the
   deterministic guard rejects claims without a frame or Law passage behind them.
6. **Human decides.** Officials confirm or overturn. The outcome flows back to the Studio Desk as a
   correction, storyline and fan-facing explainer.

It is advisory only. Offside needs calibrated multi-camera tracking, and official use would need
competition and IFAB approval, so the first build targets explaining decisions to fans and
preparing review notes. It is Phase 2: the design preview was removed from the app.

Cost and teardown
-----------------

Running resources cost money: the registry, Container Apps, Search, model usage, logs and Fabric
capacity. When finished, delete the ``rg-matchlens-hackathon`` resource group and the
**MatchLens Live** Fabric workspace. Delete only those; nothing else is touched.

Hackathon submission
--------------------

The rules require a public GitHub repository, a working demo and a demonstration video under two
minutes with no third-party copyrighted material. Publish the repository before submitting.
