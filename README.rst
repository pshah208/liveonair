MatchLens
=========

**The story behind the score.**

MatchLens turns original synthetic football events into evidence-first match
intelligence, broadcast overlays, personalized stories, and AI-directed recaps.
It is a working hackathon application, not a Premier League product or affiliation.
All clubs, players, events, and scenarios are fictional.

Live demo: https://matchlens.whiteisland-f5b236ef.eastus2.azurecontainerapps.io

What you can do
--------------

* Replay three seeded 90-minute matches, pause, scrub, and jump to match moments.
* Inspect rolling-window statistics, an animated evidence pitch, and ranked stories.
* Switch between analyst, casual fan, and favorite-player perspectives.
* Read stories and recaps in English, Spanish, and French.
* Inspect supporting event IDs, timestamps, revisions, players, and locations.
* Apply a synthetic goal correction and see the score, stories, and recap invalidate.
* Generate AI-directed story scripts and recaps, and inspect the actual workflow trace.
* Export a machine-readable story overlay with timing and evidence references.

Architecture
------------

:Client: React 19 and TypeScript, built with Vite.
:API: Express 5 and TypeScript, stateless per-viewer replay requests.
:Analytics: Deterministic event reconciliation, fixed windows, explicit source references.
:AI: Microsoft Foundry's Azure OpenAI endpoint, with tool-using analyst and producer roles.
:Hosting: Azure Container Apps, Azure Container Registry, and Log Analytics.
:Identity: User-assigned managed identity; registry pull and model inference scoped with RBAC.
:Infrastructure: Two Bicep templates and a PowerShell deployment script.

The live pipeline is ingest -> interpret -> explain -> render -> personalize.
In this MVP, ingestion is a replay of original generated events, not an external
production football feed. Event state is recomputed per request, so visitors do not
share mutable replay controls. No Fabric workspace or database is provisioned in
this version: neither is required for its bounded seeded-fixture workload.

The AI analyst requests match state and supporting evidence through restricted
tools. Both model roles use strict structured-output JSON schemas and runtime
validation. The producer selects and orders approved facts. Localized text is rendered
from the deterministic fact ledger rather than accepting unrestricted factual
prose from the model. This is deliberately bounded editorial AI, not an
unconstrained pundit or autonomous broadcast publisher. Its trace distinguishes
model roles from the deterministic grounding guard.

Synthetic data and honesty
--------------------------

The fixture seeds and scenario definitions are in ``server/fixtures.ts``.
Data can be inspected or downloaded from ``GET /api/fixtures/{id}``.
No match footage, licensed logos, real player data, or scraped match feeds are used.

Event coordinates describe logged on-ball actions, not continuous player tracking.
The app does not infer formations, off-ball runs, player speed, causal substitution
effects, or calibrated win probabilities. Illustrative synthetic xG values are
scenario attributes, not a trained expected-goals model. Structural evidence
coverage measures citation completeness, not semantic correctness or accuracy.

A goal correction revises the original event and retains it in the audit evidence.
Rescinded goals no longer contribute to the score or active story claims.
The associated shot attempt remains in the event history. Replay time, view, and
event revisions participate in a state version that invalidates stale narratives.

Local setup
-----------

Requires Node.js 22 or later and npm.

.. code-block:: powershell

   npm ci
   npm test
   npm run typecheck
   npm run build
   npm start

Open ``http://localhost:3000``. Without model configuration, replay, statistics,
stories, corrections, and evidence work; AI generation is explicitly unavailable.
There is no hidden mock narration or success-shaped fallback.

For frontend development, run ``npm run dev`` and ``npm run dev:ui`` in separate
terminals. Vite proxies ``/api`` to the backend on port 3000.

To enable real AI locally, copy ``.env.example`` to ``.env.local``, configure the
Azure endpoint/deployment, sign in with Azure CLI, and ensure the account identity
has Cognitive Services OpenAI User on that resource. Set ``AZURE_SUBSCRIPTION_ID``
to the subscription containing the resource so local inference does not use a
different Azure CLI account. If selecting by tenant instead, set
``AZURE_TENANT_ID`` and leave the subscription setting empty.

.. code-block:: powershell

   node --env-file=.env.local dist\server\index.js

Never commit environment files, tokens, API keys, or generated Azure CLI outputs.
Production uses managed identity and disables local-key authentication on the
Foundry account.

API
---

``GET /api/health`` reports application and model-configuration status, not proof of
inference availability. ``GET /api/fixtures`` returns the catalog; fixture detail
returns the full synthetic event stream.

``POST /api/analyze`` accepts a known fixture ID, integer match clock in seconds,
persona, language, optional favorite player ID, and optional correction toggle.
``POST /api/narrate`` adds ``format`` (``story`` or ``recap``) and optional story ID.
See ``shared/types.ts`` for the complete request and response contracts.

.. code-block:: json

   {
     "fixtureId": "rivergate-comeback",
     "atSecond": 4350,
     "persona": "analyst",
     "language": "en",
     "correction": false
   }

Errors are JSON with an ``error`` field. Invalid input is rejected. AI unavailable
or rejected output is surfaced, never substituted with fabricated narration.
Body sizes, per-IP rates, concurrent generation, tool iterations, and hourly
generation budgets are bounded. The hourly budget and cache are in memory:
they reset on process restart, so they are safeguards, not billing hard caps.
The app is a public demonstration endpoint, not an authenticated enterprise service.

Deploy to Azure
---------------

Requires Azure CLI, Bicep, appropriate resource/RBAC permissions, and compatible
model quota. Select the intended subscription explicitly; do not rely on the CLI
default. The provided script creates or updates only the named resource group.
Use a new resource group on your first deployment.

.. code-block:: powershell

   .\scripts\deploy.ps1 -SubscriptionId "<subscription-guid>" `
     -ResourceGroup "rg-matchlens-hackathon" -Location "eastus2"

The core template creates a new Foundry account/project and GPT-4.1 mini deployment,
an ACR Basic registry, a managed identity, logging, and a Container Apps environment.
The script builds the application in ACR, then deploys a non-root container with
HTTPS ingress, health probes, zero minimum replicas, and one maximum replica.
The app can cold-start after inactivity. It does not provision Fabric capacity,
AKS clusters, or provisioned-throughput model capacity.

For application-only updates, add ``-UseExistingInfrastructure`` and a new
``-ImageTag``. This reuses the named group's existing core deployment outputs
without modifying its model or environment.

Running resources incur Azure charges. ACR Basic has an ongoing charge; logs,
Container Apps activity, and model inference may add usage charges. The log quota
and replica limits reduce exposure but do not guarantee a maximum total bill.
Review the resource group's costs and delete that specific group when no longer
needed. Do not delete other existing environments or subscriptions.

Quality and contribution
------------------------

``npm test`` uses Node's test runner with TypeScript execution. Tests cover fixture
semantics, windows, corrections, evidence, API validation, model contract rejection,
cache isolation, and request budgets. GitHub Actions runs tests, type checking,
and the production build on pushes and pull requests.

The AI tests use an injected completion client. A deployed real model request
should also be exercised to confirm identity, quota, tool calling, and editorial
output in the target environment. Never interpret citation coverage as a
guarantee of football tactical correctness.

Suggested demo sequence
-----------------------

Open the comeback fixture, play the feed, inspect a story's evidence, switch to
casual mode and Spanish, then generate a live story. Apply the goal correction
and show the score adjustment and narrative invalidation. Finish with a full-time
recap and the workflow trace. Export the synchronized JSON overlay.

Hackathon submission
--------------------

The event's rules require a public GitHub repository, an accessible working demo,
and a demonstration video shorter than two minutes. This repository can remain
private during development; its owner must choose to publish it before submission.
Check eligibility and the current official rules independently. This app does
not create or submit a hackathon entry on your behalf.
