MatchLens
=========

**The story behind the score.**

MatchLens is a live match-intelligence studio. It ingests synthetic football events through
Microsoft Fabric, turns them into verified statistics and storylines with Microsoft Foundry agents,
and lets a human producer put approved copy on air as lower-thirds, narrated recaps and an
automatically cut highlight reel, in English, Spanish and French.

It is a hackathon application, not a Premier League product or affiliation. All clubs, players,
events and scenarios are fictional.

Live demo: https://matchlens.whiteisland-f5b236ef.eastus2.azurecontainerapps.io

.. contents::
   :local:
   :depth: 1

What you can do
---------------

The app has two desks, switched at the top of the page:

* **Studio Desk**: the producer studio described below, with three tabs (Live desk, Recap and
  highlights, Video lab).
* **VAR Desk** (next phase): a design preview of an assistant for VAR reviews. See `VAR Desk
  (next phase)`_.

A collapsible **How MatchLens works** panel at the top of the Studio Desk shows each pipeline stage
with live health.

**Live desk**

* Start a seeded fixture or generate a new match (comeback, red card, set piece, late winner,
  goal fest) at up to 60x speed. Events flow through Fabric Eventstream with the measured lag
  shown in the broadcast bar.
* Follow the scorebug, animated pitch, live stats, notable-event feed and match-intelligence
  cards. Selecting a card highlights its evidence on the pitch.
* Review the storyline queue. Every storyline shows its verified claims, sources and agent trace.
  Approve, edit or reject it; nothing goes on air without approval.
* Preview the on-air lower-third in English, Spanish or French and export it as timed JSON.
* Rule out any goal (a VAR-style correction). The score, dependent storylines, facts and
  highlight captions are retracted and rebuilt.

**Recap and highlights**

* **Highlight reel**, generated automatically from the verified events and approved storylines,
  in English, Spanish or French:

  - *Video recap*: when the match came from the Video lab, the reel is cut from that clip
    automatically, around the events the worker and the producer tagged, with storyline captions
    and a scorebug on top.
  - *Data-rendered*: synthetic matches have no footage, so the reel is an animated pitch with
    scorebug, event trail and captions.
  - *Sound*: a commentary voice reads each moment's caption in the reel language; video recaps
    also play the clip's own audio. One toggle turns both off.
  - Export the reel as WebM (with the clip audio for video recaps), or download the cut list
    (JSON plus an ffmpeg script).

* **Narrated recap** for an analyst or casual audience, in English, Spanish or French, built
  from the live view so manual corrections are reflected.
* **Recap chapters** that link each phase of the match to its storylines.

**Video lab (beta)**

* Upload a short clip you own. The video worker samples frames, a vision model tags events and
  deterministic rules turn them into a match that streams through Eventstream to the live desk.
  Tag up to five moments the model missed yourself.

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
     localizer   -> Spanish and French versions
     deterministic guard: rejects names or numbers not in verified claims, retries
             |
             v
   Producer approval (human in the loop)
             |
             v
   Outputs: lower-third JSON · narrated recap · highlight reel · cut list   (EN / ES / FR)

1. **Ingest.** The simulator publishes each event to a Fabric Eventstream custom endpoint.
   Eventstream fans it out to Eventhouse and back to the app over a second custom endpoint.
   Without Eventstream credentials the app uses an in-process bus and says so.
2. **Store.** Eventhouse keeps raw events and a typed ``MatchEvents`` table via a KQL update
   policy, plus the synthetic archive used for historical context.
3. **Interpret.** A deterministic engine recomputes score, rolling statistics, illustrative xG and
   evidence-linked story cards on every event. Only the latest revision of each event counts.
4. **Explain.** On key events the storyline desk runs four Foundry agents. Claims are verified
   deterministically before a producer ever sees them.
5. **Render and personalise.** Approved copy becomes lower-thirds, recaps (analyst or casual) and
   highlight captions in three languages.

Highlight reel
~~~~~~~~~~~~~~

``shared/highlights.ts`` ranks verified events: goals, ruled-out goals, red cards, big chances
(xG >= 0.25), key saves (shot xG >= 0.15) and bookings. Video-lab matches have no xG, so every
missed or saved attempt and every save counts. A moment scores higher if an approved
storyline covers it. The top moments (eight by default) get a time window that starts before the
moment; overlapping windows are merged so no footage repeats. Each clip's caption is the approved
storyline overlay in the chosen language, falling back to English (flagged in the UI) or to a
built-in caption.

The same clip list drives every output:

:Video recap: For a Video lab match, the processed clip plays in a hidden video element and a
              canvas draws it with the overlays. Video-lab events run on the clip's own clock, so
              each event second is the same second in the footage; no manual alignment is needed.
:Data-rendered: Canvas animation at 1280x720, recorded to WebM with ``MediaRecorder``.
:Cut list: JSON timecodes plus a bash script that cuts and joins the clips with ffmpeg in an
           edit suite.
:Sound: The browser's speech engine reads each clip's caption as the reel reaches it. Video
        recap exports include the clip audio through Web Audio; the voice is live only.

Synthetic matches have no footage of their own, so their reel is always data-rendered.

Video lab (beta)
~~~~~~~~~~~~~~~~

The Video lab turns a short clip you own into match events, the way a vision feed could replace a
data provider. It follows the PlayerIQ worker pattern, in-process for this demo:

1. **Upload.** The browser streams the clip (MP4, MOV or WebM, at most 100 MB and 3 minutes) to
   ``POST /api/video/jobs``. Uploading requires confirming you filmed it or have a licence.
2. **Probe and sample.** ffprobe checks the stream; ffmpeg extracts up to 60 frames (one every 1–3
   seconds) at 768 px.
3. **Tag.** Batches of 12 frames go to gpt-4.1-mini with a strict JSON schema. The model reports
   event type, team (by kit), legible shirt number, frame position and confidence, plus a footage
   check. Test patterns, animations and games are rejected after the first batch.
4. **Apply rules.** Deterministic code keeps detections at 50% confidence or more with a known team,
   merges repeats, adds a shot before every goal, links saves to shots and registers a fixture.
5. **Stream.** *Stream to live desk* publishes the events through Fabric Eventstream at real time
   while the clip plays with a scorebug and event overlays. Storyline agents, stats and the
   highlight reel then run on what the camera saw.

Each detected event shows the model's description, its confidence and the exact frame it saw.
*Swap teams* fixes a clip where the model put the kits on the wrong sides. *Tag a missed moment*
adds up to five producer events (type, team, time, optional shirt number and note). Tags are
trusted over model reports of the same moment, still get the shot-before-goal rule, and are marked
"you" in the evidence table. Once streamed, **Recap and highlights** cuts a video recap from the
clip.

Limits: sampled stills miss quick passes; there is no player tracking, so positions are frame
positions; players are identified only by legible numbers. A fan-filmed clip that cuts away at the
goal produces a shot, not a goal. In production a licensed event feed such as Opta replaces this
step; the rest of the pipeline is unchanged.

Microsoft and Azure services
----------------------------

=================================  ==========================================================
Service                            Use
=================================  ==========================================================
Microsoft Fabric Eventstream       Real-time event ingestion and fan-out
Fabric Eventhouse (KQL)            Event store, update policy, archive, producer KQL functions
Microsoft Foundry Agent Service    Researcher, producer, fact-checker and localizer agents
Foundry IQ and Azure AI Search     Knowledge base over the synthetic archive
Azure OpenAI (gpt-4.1-mini)        Agents, recap narration and Video lab frame tagging (vision)
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
* Nothing goes on air without producer approval. Edits are recorded in the trace.
* A goal correction keeps the original event in the audit trail and retracts dependent output.
* Uploading a clip to the Video lab requires confirming you filmed it or have a licence. The
  source file is deleted once processing finishes; the video recap plays from the copy in your
  browser.
* The video worker fails closed: frames that are not real football footage stop the job before any
  events exist, and only detections that cite a sampled frame are kept.
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
the in-process event bus. Agents and recaps report that they are not configured.

To enable AI and Fabric locally, copy ``.env.example`` to ``.env.local``, fill in the values below,
sign in with ``az login`` and run ``node --env-file=.env.local --import tsx server/index.ts``.

.. list-table::
   :header-rows: 1
   :widths: 45 55

   * - Variable
     - Purpose
   * - ``AZURE_OPENAI_ENDPOINT``, ``AZURE_OPENAI_DEPLOYMENT``
     - Recap narrator model
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
   .\scripts\deploy.ps1 -SubscriptionId "<subscription-guid>" -ImageTag v0-6-0 -UseExistingInfrastructure

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
     - Recap of the live view (persona and language)
   * - ``GET /api/studio/storylines``
     - Storyline queue with claims and traces
   * - ``POST /api/studio/storylines/{id}/review``
     - ``approve``, ``edit`` or ``reject``
   * - ``GET /api/studio/facts``, ``GET /api/studio/storyboard``
     - Verified facts; recap chapters
   * - ``GET /api/archive/summary``, ``/players/{id}``, ``/export``
     - Synthetic archive
   * - ``POST /api/video/jobs``
     - Upload a clip (raw MP4, MOV or WebM body, at most 100 MB and 3 minutes; team names and kits as query parameters)
   * - ``GET /api/video/jobs/{id}``, ``/frames/{n}``
     - Worker progress, detected events with evidence; the exact frame the model saw
   * - ``POST /api/video/jobs/{id}/swap-teams``, ``/live``
     - Flip home and away kits; stream the detected events through the live pipeline at real time
   * - ``POST /api/video/jobs/{id}/tags``, ``DELETE .../tags/{tagId}``
     - Add or remove a producer tag (at most five per clip; ``type``, ``team``, ``second``, optional ``shirtNumber`` and ``note``)
   * - ``GET /api/video/jobs``, ``DELETE /api/video/jobs/{id}``
     - Clip library, newest first; delete a finished clip with its frames, events, tags and fixture

Request and response contracts are in ``shared/types.ts`` and ``shared/platform.ts``. Inputs are
validated with zod; bodies, request rates and AI concurrency are bounded.

Testing
-------

``npm test`` runs Node's test runner across the engine, fixtures, live pipeline, storyline desk
(including rate-limit retry and the guard), narrator contracts, archive, API and highlight
selection, including the cut-list time mappings and localisation. CI runs tests, typecheck and the
production build on every push.

Two-minute demo
---------------

1. Open **How MatchLens works** and explain the pipeline. Collapse it.
2. Start the comeback fixture at 60x speed. Point out Fabric transport and lag.
3. Open a storyline: claims, sources, agent trace. Approve it and show the lower-third in Spanish.
4. Rule out a goal. The score, storylines and captions update.
5. Switch to **Recap and highlights**. Play the reel, switch it to French and export it.
6. Generate a casual recap in Spanish.

Phase 2: path to production
---------------------------

The design (event stream, Fabric, agents, human approval, cut list) suits a rights holder such
as a league or broadcaster. This build is a single-tenant demo. A pilot would need:

==============================  =========================================  ==========================================
Area                            Today                                      Phase 2
==============================  =========================================  ==========================================
Event source                    Built-in synthetic feed                    Adapter that maps a licensed live data
                                                                           feed into the MatchLens event schema and
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
Video auto-eventing             Video lab: in-process worker, short        Blob upload, Service Bus queue and a
                                clips, frame sampling and a vision model   Container Apps Job worker (as in
                                                                           PlayerIQ); player tracking for passes
                                                                           and speeds
Languages                       English, Spanish, French                   More localizer languages and translated
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
