# Live on Air: 2-minute demo video script

Target length is 2:00, with about 290 words of voice-over (VO) at roughly 145 words per minute. Record the screen at 1080p on the live deployment (`https://liveonair.whiteisland-f5b236ef.eastus2.azurecontainerapps.io`).

**Before recording:**
- Start a generated `late_winner` match at speed 20 from the Studio Desk.
- Pause it at about 70', then resume it on camera.
- All match data is synthetic; the opening slate says so.

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:12 | Title card: "Live on Air: one live feed, every audience." Then cut to the Studio Desk with the match running. | "Every match produces thousands of events. Live on Air turns that one feed into a broadcast story for producers and a personal story for every fan, as it happens." |
| 0:12–0:30 | Live board: the tracking dots move, the event chip updates, and the score and clock tick. | "This is a live Premier League-style match, fully synthetic. Events stream through Microsoft Fabric Eventstream, and the board rebuilds player movement in real time, five frames a second. Live and replay are identical." |
| 0:30–0:50 | Metrics panel: xG, pass quality, completion vs expected, chance build-up. Hover over one chance. | "Every event is scored as it lands: expected goals, pass difficulty, completion versus expected, and how each chance was built. The definitions are documented and tested." |
| 0:50–1:15 | Storyline desk: agent cards hand off in turn (researcher, tactics and player analysts, fact-checker, producer, localizer), then a storyline is published. | "Behind it sits a newsroom of seven Azure AI Foundry agents. A director routes the work. Analysts draft the angle, a researcher grounds it in the archive with Azure AI Search, a fact-checker verifies every number against the feed, and a localizer translates it. Nothing goes on air unchecked." |
| 1:15–1:35 | Switch to Fan View on a phone frame. Pick a favourite club, a player and a language, and show a personal insight. | "Fans get the same verified feed, made personal: their club, their player, their language." |
| 1:35–1:48 | Back in the Studio: click Pause, the clock holds, click Resume, and the late winner goes in. | "Producers stay in control: pause, resume, and let the drama play out." |
| 1:48–2:00 | Architecture slide: Container Apps, Foundry, AI Search, Fabric, App Insights, managed identity, MCP. End card with the URL. | "It runs on Azure Container Apps with managed identity, full monitoring, and an MCP endpoint so developer agents can plug in. Live on Air: one feed, every story." |

## Production notes
- Keep cuts on the beat of the VO, and don't let any shot run longer than 20 s.
- Add captions; the judges may watch with the sound off.
- If AI narration is slow on camera, pre-record the desk segment from the same match and cut it in.
- Don't show real player names or club badges; use the synthetic rosters only.
