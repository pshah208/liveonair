# ADR 0001: Web-grounded post-match narratives

## Status

Accepted

## Context

Post-match storylines have to weave three kinds of material: the verified match feed, the synthetic archive (careers, coaches, previous meetings, family links) and current narrative context. The demo clubs and people are fictional. Competition rule 4.7 requires synthetic, football-realistic data, so real news must never be attached to those names.

The Azure OpenAI Responses API on this account accepts a built-in `web_search` tool without an API key when called at `${AZURE_OPENAI_ENDPOINT}/openai/v1/` with a Microsoft Entra token for `https://cognitiveservices.azure.com/.default`. The narrator deployment is `matchlens-narrator` (gpt-4.1-mini). Two limits were verified on that deployment:

- `text.format` json_schema drops `url_citation` annotations, so a structured storyline call cannot be the citation source.
- `filters.allowed_domains` returns HTTP 400, so domain policy cannot be delegated to the tool.

## Decision

Keep storyline writing and web scouting as separate calls.

1. A free-text news-scout call uses `web_search` with `search_context_size: low`, a GB approximate location, and `include: ["web_search_call.action.sources"]`. It does not use json_schema.
2. A citation is usable only when its `url_citation` URL is also present on `web_search_call.action.sources` and the host is not on the in-process social/user-generated block list. The match is exact after normalising scheme and host case, a trailing slash and a fragment. The port is part of the match (`URL.host`); default ports 80 and 443 are omitted. The query string is preserved, so a different query, port or path suffix is discarded. The writer may not invent a URL.
3. Because demo people and clubs are fictional, the scout searches public situation precedent only (comebacks, early red cards, late winners, set pieces). A club or adult person name is added only when that archive record sets `realWorld`. None of the shipped demo records do.
4. Synthetic coaches and a synthetic news wire live in the archive. Retrieval is in-process (`searchNewsWire`) so the feature works without re-provisioning Foundry IQ. An optional `liveonair-news-scout` agent spec is provisioned for later use; the request path does not depend on it.
5. `NARRATIVE_WEB_SEARCH=off` disables the scout. The default is on only when `AZURE_OPENAI_ENDPOINT` is set. Timeout is 15 seconds. Failure, an empty citation set, or the kill switch produces storylines from the feed, archive and news wire, labelled exactly `No live web context`.
6. Every storyline is checked only against the evidence it cites, with the existing spoken-guard rules plus archive and news-wire names. An unlisted name or number is rejected and retried once, then the deterministic fallback is served. Web snippet text is untrusted quoted data: the prompt tells the model to ignore instructions inside it, and fallback copy uses `Around the game: <title> (<domain>)` rather than the snippet.
7. The contract is `POST /api/live/storylines/postmatch`, not a change to `POST /api/live/narrate`.
8. Generation is bounded per match, not per caller. A successful scout runs at most once per match and is reused across languages and personas. A failed scout is not cached as a permanent error, and is not retried more than twice for that match. Finished and so-far copy stay for the match lifetime; only whole matches are evicted. A finished recap is written once per language and persona. So-far copy is written at most once per five minutes of match clock. If a match fills its finite language × persona × bucket cap, later requests reuse the latest result for that language instead of generating. Favourites are ordered after generation and do not trigger another model call. Identical in-flight requests share one generation. The hourly budget reads `AI_MAX_REQUESTS_PER_HOUR` and `AI_MAX_CONCURRENT`, the same settings as the live narrator. The route has its own limiter; that limiter is not the cost bound.
9. `narrativeWebSearch` is a bicep parameter (`on` or `off`, default `on`) wired to `NARRATIVE_WEB_SEARCH`. Deploy passes it only when the caller sets `-NarrativeWebSearch`.

## Consequences

- Web queries leave the Azure compliance boundary. Only public topics are sent. Logs record status, not page contents or personal data.
- Re-provisioning the search index is not required for news-wire retrieval. Re-running `scripts/provision-desk.ts` will index the new documents and create the optional scout agent.
- gpt-4.1-mini cannot enforce an allow-list of domains. Preferring reputable hosts is a sort, not a gate. Social and user-generated hosts are blocked locally.
- The first scout for a match is reused even if the scoreline changes later. That keeps web search to one call per match.
- Fan View can call the same endpoint later. Studio mounts `src/PostMatchStorylines.tsx`.
