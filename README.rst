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

The app has two desks, switched at the top of the page:

* **Studio Desk**: the producer studio described below, with four tabs (Live desk, Recap and
  highlights, Video lab, Player cam).
* **VAR Desk** (next phase): a design preview of an assistant for VAR reviews. See `VAR Desk
  (next phase)`_.

A collapsible **How Live on Air works** panel at the top of the Studio Desk shows each pipeline stage
with live health.

**Live desk**

* Select a local video in **Choose a video and play**. Playback starts without a full-file upload;
  after rights confirmation, sampled frames upload in bounded batches while analysis publishes
  events through the live transport. The original file remains on your device.
* Start a seeded fixtureor generate a new match (comeback, red card, set piece, late winner,
  goal fest) at up to 60x speed. Events flow through Fabric Eventstream with the measured lag
  shown in the broadcast bar.
* Follow the scorebug, animated pitch, live stats, notable-event feed and match-intelligence
  cards. Selecting a card highlights its evidence on the pitch.
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
* **Recap chapters** that link each phase of the match to its storylines.

**Video lab**

* A dedicated **local-first match review** workbench, not the Live Desk progressive panel.
  Watch browser-playable footage with slow motion and approximate stepping, without cloud setup
  or upload permission. Limits: **15 minutes / 500 MB (500 MiB) / 200 annotations per file**.
* Mark **I/O** ranges or use moment presets; edit categories, team, players, outcome and notes.
  Preview, edit and delete annotations in the timeline and reviewed clip library.
* Filter the timeline, library and detailed tagged-observation analysis together. Counts describe
  saved tags, not inferred possession, xG, tracking or authoritative match statistics.
* Save reviews per local file fingerprint; export/import a matching-source JSON backup or export
  the filtered annotations as CSV. Backups contain metadata, not video.
* Optionally authorize a full upload for AI suggestions, inspect their evidence and explicitly
  add selected suggestions to the review timeline.
* **Send to the live desk**: once AI detection has built the match feed, send up to five marked
  moments (goal, red card, save, foul, card, set piece...) as producer tags, then **Go live on the
  desk**. The clip's events stream in real time, agents draft storylines, and approved moments and
  red cards land in the highlights and recap cut from this footage. Nothing changes the live score
  until you go live.

**Player cam (beta)**

* A fan experience: upload a clip (up to 15 minutes and 500 MB), click the player you want to follow
  (or give their shirt number and kit) and get a personal highlight reel with a spotlight on them,
  in landscape or a vertical 9:16 cut that pans with the player. Nothing is sent to Eventstream.

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
   Storyline desk (Microsoft Foundry agents)
     researcher  -> Foundry IQ knowledge base over Azure AI Search (archive)
     producer    -> drafts headline, on-air line and overlay from verified claims only
     fact-checker-> re-checks every claim against feed events and archive records
     localizer   -> Spanish, French and Portuguese versions
     deterministic guard: rejects names or numbers not in verified claims, retries
             |
             v
   Producer approval (human in the loop)
             |
             v
   Outputs: lower-third JSON · narrated recap · highlight reel · cut list   (EN / ES / FR / PT)

1. **Ingest.** The simulator publishes each event to a Fabric Eventstream custom endpoint.
   Eventstream fans it out to Eventhouse and back to the app over a second custom endpoint.
   Without Eventstream credentials the app uses an in-process bus and says so.
2. **Store.** Eventhouse keeps raw events and a typed ``MatchEvents`` table via a KQL update
   policy, plus the synthetic archive used for historical context.
3. **Interpret.** A deterministic engine recomputes score, rolling statistics, illustrative xG and
   evidence-linked story cards on every event. Only the latest revision of each event counts.
4. **Explain.** On key events the storyline desk runs four Foundry agents. Claims are verified
   deterministically before a producer ever sees them.
5. **Render and personalise.** Approved copy becomes lower-thirds, recaps and
   highlight captions in four languages.

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

Video Lab: pundit review and hand-off
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Video Lab is a dedicated workbench for manual tagging and detailed local analysis. Its state
stays mounted across tab switches, separately from the Live Desk progressive panel; leaving
Video Lab pauses its player. A four-step strip (mark, build the match feed, add key calls, go live)
shows where the review stands. Nothing starts a live session until **Go live on the desk**.

1. **Watch.** Select a local MP4, MOV or WebM, up to 900 seconds and 524288000 bytes (500 MiB,
   labelled 500 MB). Use play/pause, ±5-second seeks, 0.25x/0.5x slow motion or faster playback.
   Step controls seek approximately 0.04 seconds, not exact video frames.
2. **Annotate.** Mark in/out with buttons or **I/O** while the workbench has focus outside inputs
   and native controls. Category presets pad the current moment by 3 seconds before and 5 after,
   bounded by the source. Save a title, category (goal, shot, pass, tackle, pressing, set piece,
   defensive shape, custom, save, foul, yellow card or red card), home/away/neutral team, player
   tags, observed outcome and notes.
   Up to 200 annotations are allowed; a preset does not count until saved.
3. **Review.** Timeline markers and library clips play to their out point. Edit ranges and details
   or delete annotations. Search and filter by team, player, category, manual/AI origin and
   overlapping time window; the timeline, library, statistics and CSV use the same filters.
4. **Understand.** Analysis shows tagged shots, goals, passes and defensive actions, team and
   outcome breakdowns, player tag counts and activity by clip start. Tagged pass success excludes
   unknown outcomes. Goals do not automatically add shots to these counts. Only saved manual
   tags and intentionally imported AI suggestions count: no possession, xG or tracking is
   inferred, and review coverage is not a performance ranking or match truth.
5. **Keep a backup.** Annotations and filters are saved in browser local storage keyed by filename,
   size and last-modified time, not a content hash. Reselect the same original file after reload.
   JSON backup/report export includes all annotations, active filters and recomputed filtered
   statistics. Import validates the matching fingerprint and duration before an explicit
   replacement; supplied statistics are recomputed. JSON is limited to 1 MiB. CSV exports only
   filtered annotations, with formula-like cells escaped. Neither export contains video.

Storage failures, corrupt saved data or changes from another tab pause automatic saving and
preserve existing storage; export the in-memory review before explicitly replacing saved data.
This is per-browser, per-device storage, not an account or cloud library.

**Browser decoding is required for local tagging and the optional AI action in this UI.**
If decoding fails, convert the source to a supported codec such as H.264 MP4 or WebM and
reselect it. Although the full-upload API uses ffmpeg, it is not a browser-codec workaround
for the current Video Lab workbench. Manual tagging needs neither Azure nor upload permission.

Optional full-upload AI suggestions
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Expand **AI-assisted event detection**, supply team names and kit descriptions, and explicitly
confirm permission to use the footage and upload the full original for AI analysis. This
requires configured vision and video processing; manual tagging remains available while it runs.
The in-process worker follows these steps:

1. **Upload.** ``POST /api/video/jobs`` accepts the full MP4, MOV or WebM within the same limits
   and returns ``202`` with a job to poll.
2. **Probe and sample.** ffprobe checks the stream; ffmpeg extracts frames at 768 px. Clips of
   180 seconds or less keep the original sampling: at most 60 frames, one every 1–3 seconds.
   Longer clips sample approximately every 3 seconds, up to 300 frames.
3. **Tag.** Sequential batches of up to 12 frames (at most 25 batches) go to gpt-4.1-mini with a
   strict JSON schema. The model reports event type, team (by kit), legible shirt number, frame
   position and confidence, plus the footage classification described below.
4. **Apply rules.** Deterministic code keeps detections at 50% confidence or more with a known team,
   merges repeats, adds a shot before every goal, links saves to shots and registers a fixture.
   Registering a fixture does not start a live stream.
5. **Review and import.** Inspect suggestions and evidence, select the ones to keep and press
   **Add to review timeline**. Imports deduplicate by job/event provenance, which remains immutable
   when annotation details are edited. Rule-inferred shots are labelled as such, with no visual
   frame evidence or measured confidence; uncertain/defaulted outcomes remain unknown.

Processing is asynchronous; longer clips require more time and vision batches, not instant
analysis. Jobs are in memory, not durable across server restarts. Uploaded sources are deleted
after processing; sampled frames remain as session evidence until cleanup/eviction and playback
uses the local file. Imported annotations persist with the local review, not as a durable AI job.
**Stop waiting and unlock source** detaches the result from this review; it does not cancel
server processing. A failed analysis requires a deliberate new upload, not an automatic rerun.

**Send to the live desk** uses ``POST /api/video/jobs/{id}/tags`` (up to five producer tags; the
tag time is the marked moment, 3 s after a preset's in point) and ``POST /api/video/jobs/{id}/live``
to stream the ready job in real time. Pressing, defensive shape and custom moments stay as analysis
only. Saving or importing review annotations never calls these endpoints on its own.

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
fan product, so it never touches Eventstream or the live desk.

The same 15-minute / 500 MB limit and asynchronous processing apply. Clips of 180 seconds or less
still use at most 60 frames at 1–3 second intervals; longer clips sample approximately every
3 seconds, up to 300 frames in at most 25 sequential batches of 12. Longer clips take longer to
process. The uploaded source is deleted after processing; the reel plays from the local clip.

1. **Identify.** The fan pauses the clip and clicks the player; the shirt number and kit are
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
   The fan can untick wrong moments; sound plays the clip audio plus a voice that calls each
   moment; the export includes the clip audio.

Microsoft and Azure services
----------------------------

=================================  ==========================================================
Service                            Use
=================================  ==========================================================
Microsoft Fabric Eventstream       Real-time event ingestion and fan-out
Fabric Eventhouse (KQL)            Event store, update policy, archive, producer KQL functions
Microsoft Foundry Agent Service    Researcher, producer, fact-checker and localizer agents
Foundry IQ and Azure AI Search     Knowledge base over the synthetic archive
Azure OpenAI (gpt-4.1-mini)        Agents, narration, progressive vision and optional Video Lab suggestions
Azure AI Speech (HD neural TTS)    Spoken highlights commentary and recap audio, on the Foundry account
Azure Container Apps               API and studio UI, server-sent events for live updates
Azure Container Registry           Image builds (``az acr build``)
Managed identity and RBAC          Keyless access to Foundry, Search and the registry
Log Analytics                      Container logs
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
* Video Lab manual review stays local. Optional full-upload AI requires explicit footage/upload
  permission; Live Desk progressive AI separately requires permission to send sampled frames.
  Full-upload sources are deleted after processing and playback uses the local file.
* Progressive/full-upload event analysis skips explicitly classified football broadcast graphics
  without using detections or kits, rejects unsupported footage and fails completion if no match
  footage was seen. Progressive failures preserve partial coverage, not a claim of full-time
  analysis. Model detections must cite sampled frames; rule-inferred suggestions are labelled.
* When the model is unavailable, AI features say so; there is no hidden mock narration.

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

Do not run locally with the deployed app's Eventstream credentials; both instances would share
one stream. Never commit ``.env.local`` or ``fabric/.secrets.local.json``.

Provisioning
------------

.. code-block:: powershell

   # Azure: Foundry, model, Search, registry, Container Apps
   .\scripts\deploy.ps1 -SubscriptionId "<subscription-guid>" -ResourceGroup "rg-matchlens-hackathon"

   # Foundry agents and the Foundry IQ knowledge base
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
     - Server-sent events: match events, storylines, facts
   * - ``GET /api/live/status``, ``GET /api/live/fixture``
     - Clock, transport and lag; the live view with every event revision
   * - ``POST /api/live/narrate``
     - Recap of the live view (persona and language), with ``audioUrl``
   * - ``POST /api/live/highlights/commentary``
     - Spoken commentary for the reel's clips (language, clip windows), with audio URLs
   * - ``GET /api/audio/{id}.mp3``
     - Neural-voice audio for server-generated recap and commentary text only
   * - ``GET /api/studio/storylines``
     - Storyline queue with claims and traces
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
(including rate-limit retry and the guard), narrator contracts, archive, API and highlight
selection, including the cut-list time mappings and localisation. CI runs tests, typecheck and the
production build on every push.

Two-minute demo
---------------

1. Open **How Live on Air works** and explain the pipeline. Collapse it.
2. Start the comeback fixture at 60x speed. Point out Fabric transport and lag.
3. Open a storyline: claims, sources, agent trace. Approve it and show the lower-third in Spanish.
4. Rule out a goal. The score, storylines and captions update.
5. Switch to **Recap and highlights**. Play the reel, switch it to French and export it.
6. Generate a recap in Spanish.

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

VAR Desk (next phase)
---------------------

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
preparing review notes. Today the desk is a design preview with no live connections.

Cost and teardown
-----------------

Running resources cost money: the registry, Container Apps, Search, model usage, logs and Fabric
capacity. When finished, delete the ``rg-matchlens-hackathon`` resource group and the
**MatchLens Live** Fabric workspace. Delete only those; nothing else is touched.

Hackathon submission
--------------------

The rules require a public GitHub repository, a working demo and a demonstration video under two
minutes with no third-party copyrighted material. Publish the repository before submitting.
