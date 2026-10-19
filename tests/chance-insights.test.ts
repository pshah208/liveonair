import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import {
  buildChanceSequence,
  buildTerritory,
  chanceClaimText,
  chanceInsightId,
  recomputeChanceInsights,
  type ChanceInsight,
} from "../shared/chanceSequence.js";
import type { LiveMessage, VerifiedFact } from "../shared/platform.js";
import type { MatchEvent, MatchFixture, MatchSnapshot, Team } from "../shared/types.js";
import { isLiveMessage } from "../src/liveMessage.js";
import { createChanceInsightFeed } from "../server/chanceInsights.js";
import type { LiveListener, LiveMatchView, LiveService, StorylineDesk } from "../server/contracts.js";
import { getArchive } from "../server/archive/index.js";
import { buildArchiveIndexes, buildChanceSequenceProposal, guardDraftText, verifyClaimProposal } from "../server/desk/claims.js";
import { createStorylineDesk, type AgentRunner } from "../server/desk/index.js";
import { createLiveRouter } from "../server/routes/live.js";

function event(input: Partial<MatchEvent> & Pick<MatchEvent, "id" | "minute" | "second" | "type" | "teamId" | "playerId">): MatchEvent {
  return { revision: 1, outcome: "none", x: 50, y: 50, ...input };
}

function team(id: "home" | "away", name: string): Team {
  return {
    id,
    name,
    shortName: id === "home" ? "HOM" : "AWY",
    players: [{ id: `${id}-p9`, name: id === "home" ? "Ada Home" : "Bea Away", number: 9, position: "ST", teamId: id }],
  };
}

function fixture(events: MatchEvent[], id = "fixture-chance"): MatchFixture {
  return {
    id,
    seed: 1,
    title: "Home vs Away",
    description: "Synthetic chance fixture",
    home: team("home", "Home FC"),
    away: team("away", "Away FC"),
    events,
    durationSeconds: 5400,
    correctionEventId: "shot-1",
    correctionAvailableAt: 0,
  };
}

function view(events: MatchEvent[], id = "fixture-chance"): LiveMatchView {
  const match = fixture(events, id);
  const clock = Math.max(0, ...events.map((item) => item.minute * 60 + item.second));
  return { matchId: "match-chance", fixture: match, clockSecond: clock };
}

test("sequence stops at a turnover, a time gap, a stoppage, a corner origin and the action cap", () => {
  const shot = event({ id: "shot-1", minute: 12, second: 20, type: "shot", teamId: "home", playerId: "home-p9", outcome: "saved", x: 88, y: 40 });
  const turnover = buildChanceSequence([
    event({ id: "away-pass", minute: 12, second: 10, type: "pass", teamId: "away", playerId: "away-p9", outcome: "complete", x: 40, y: 40, endX: 55, endY: 40 }),
    event({ id: "home-pass", minute: 12, second: 16, type: "pass", teamId: "home", playerId: "home-p9", outcome: "complete", x: 30, y: 40, endX: 70, endY: 40 }),
    shot,
  ], shot, false);
  assert.ok(turnover);
  assert.equal(turnover.boundary, "turnover");
  assert.deepEqual(turnover.eventIds, ["home-pass", "shot-1"]);
  assert.equal(turnover.inferred, true);

  const gapped = buildChanceSequence([
    event({ id: "early", minute: 12, second: 0, type: "pass", teamId: "home", playerId: "home-p9", outcome: "complete", x: 20, y: 20 }),
    shot,
  ], shot, false);
  assert.equal(gapped?.boundary, "time_gap");
  assert.deepEqual(gapped?.eventIds, ["shot-1"]);

  const stopped = buildChanceSequence([
    event({ id: "foul", minute: 12, second: 18, type: "foul", teamId: "away", playerId: "away-p9" }),
    shot,
  ], shot, false);
  assert.equal(stopped?.boundary, "stoppage");
  assert.deepEqual(stopped?.eventIds, ["shot-1"]);

  const corner = event({ id: "corner", minute: 12, second: 14, type: "corner", teamId: "home", playerId: "home-p9", x: 99, y: 2 });
  const fromCorner = buildChanceSequence([
    event({ id: "before", minute: 12, second: 8, type: "pass", teamId: "home", playerId: "home-p9", outcome: "complete", x: 10, y: 10 }),
    corner,
    event({ id: "after", minute: 12, second: 16, type: "pass", teamId: "home", playerId: "home-p9", outcome: "complete", x: 80, y: 30, endX: 86, endY: 36 }),
    shot,
  ], shot, false);
  assert.equal(fromCorner?.boundary, "corner_origin");
  assert.equal(fromCorner?.origin.type, "corner");
  assert.equal(fromCorner?.origin.zone, "final");
  assert.deepEqual(fromCorner?.eventIds, ["corner", "after", "shot-1"]);
  assert.equal(fromCorner?.passes, 1);

  const chain = [event({ id: "kick", minute: 20, second: 0, type: "kickoff", teamId: "home", playerId: "home-p9" })];
  for (let index = 0; index < 12; index += 1) {
    chain.push(event({
      id: `pass-${index}`,
      minute: 20,
      second: index + 1,
      type: "pass",
      teamId: "home",
      playerId: "home-p9",
      outcome: "complete",
      x: 10 + index,
      y: 40,
      endX: 11 + index,
      endY: 40,
    }));
  }
  const cappedShot = event({ id: "shot-cap", minute: 20, second: 14, type: "shot", teamId: "home", playerId: "home-p9", outcome: "miss", x: 90, y: 40 });
  chain.push(cappedShot);
  const capped = buildChanceSequence(chain, cappedShot, false);
  assert.equal(capped?.boundary, "action_cap");
  assert.equal(capped?.actions, 10);
  assert.equal(capped?.eventIds.at(-1), "shot-cap");
  assert.ok((capped?.matchClockSpanSeconds ?? 0) > 0);
});

test("same-second events keep feed order, not id order", () => {
  const shot = event({ id: "a-shot", minute: 12, second: 20, type: "shot", teamId: "home", playerId: "home-p9", outcome: "saved", x: 88, y: 40 });
  const pass = event({ id: "z-pass", minute: 12, second: 20, type: "pass", teamId: "home", playerId: "home-p9", outcome: "complete", x: 40, y: 40, endX: 70, endY: 40 });
  const sequence = buildChanceSequence([pass, shot], shot, false);
  assert.ok(sequence);
  assert.deepEqual(sequence.eventIds, ["z-pass", "a-shot"]);
  assert.equal(sequence.passes, 1);
  assert.equal(sequence.boundary, "match_start");
});

test("territory nulls missing endX and camera fixtures null progression", () => {
  const shot = event({ id: "shot-1", minute: 10, second: 0, type: "shot", teamId: "home", playerId: "home-p9", outcome: "saved", x: 90, y: 40 });
  const events = [
    event({ id: "origin", minute: 9, second: 50, type: "pass", teamId: "home", playerId: "home-p9", outcome: "complete", x: 40, y: 40, endX: 55, endY: 40 }),
    event({ id: "entry", minute: 9, second: 0, type: "pass", teamId: "home", playerId: "home-p9", outcome: "complete", x: 40, y: 40 }),
    event({ id: "known", minute: 9, second: 10, type: "pass", teamId: "home", playerId: "home-p9", outcome: "complete", x: 60, y: 40, endX: 80, endY: 40 }),
    shot,
  ];
  const territory = buildTerritory(events, shot);
  assert.equal(territory.label, "event-derived territory");
  assert.equal(territory.home.current.finalThirdEntries, null);
  assert.equal(territory.home.current.completedPassesEndingInFinalThird, null);
  assert.equal(territory.home.current.passesMissingEndX, 1);
  assert.equal(territory.home.current.attackingActions, 3);
  assert.equal(territory.label, "event-derived territory");
  assert.match(territory.coverageNotes.join(" "), /not possession and not pressure/u);

  const sequence = buildChanceSequence(events, shot, true);
  assert.equal(sequence?.progressionM, null);
  assert.equal(sequence?.origin.eventId, "origin");
  const pitched = buildChanceSequence(events, shot, false);
  assert.equal(pitched?.progressionM, ((90 - 40) / 100) * 105);
});

test("insight lifecycle revises on a contributing event and withdraws a rescinded shot", () => {
  const pass = event({ id: "pass-1", minute: 8, second: 0, type: "pass", teamId: "home", playerId: "home-p9", outcome: "complete", x: 20, y: 40, endX: 40, endY: 40 });
  const shot = event({ id: "shot-1", minute: 8, second: 5, type: "shot", teamId: "home", playerId: "home-p9", outcome: "saved", x: 84, y: 40 });
  const first = recomputeChanceInsights({
    previous: [],
    events: [pass, shot],
    matchId: "match-chance",
    atSecond: 485,
    camera: false,
    effectiveSecond: 485,
  });
  assert.equal(first.insights.length, 1);
  assert.equal(first.insights[0]?.status, "issued");
  assert.equal(first.insights[0]?.revision, 1);
  assert.equal(first.insights[0]?.insightId, chanceInsightId("shot-1"));

  const revisedPass = { ...pass, revision: 2, x: 25 };
  const revised = recomputeChanceInsights({
    previous: first.insights,
    events: [pass, revisedPass, shot],
    matchId: "match-chance",
    atSecond: 486,
    camera: false,
    effectiveSecond: 486,
  });
  assert.equal(revised.insights[0]?.status, "revised");
  assert.equal(revised.insights[0]?.revision, 2);
  assert.match(revised.insights[0]?.revisionReason ?? "", /revised/u);

  const rescinded = { ...shot, revision: 2, rescinded: true };
  const withdrawn = recomputeChanceInsights({
    previous: revised.insights,
    events: [pass, revisedPass, shot, rescinded],
    matchId: "match-chance",
    atSecond: 490,
    camera: false,
    effectiveSecond: 490,
  });
  assert.equal(withdrawn.insights[0]?.status, "withdrawn");
  assert.equal(withdrawn.insights[0]?.withdrawalReason, "Shot or goal was rescinded");
  assert.equal(withdrawn.changed.length, 1);
});

test("guard accepts chance-sequence numbers only when the verified claim lists them", () => {
  const numbers = {
    shotEventId: "shot-1",
    actions: 7,
    passes: 6,
    players: 3,
    originZone: "defensive" as const,
    progressionM: 42,
    matchClockSpanSeconds: 11,
    boundary: "turnover" as const,
    ownHalf: true,
    finalThirdEntries: 2,
    completedPassesEndingInFinalThird: 4,
    attackingActionsInFinalThird: 5,
    attackingActions: 9,
    windowMinutes: 10,
  };
  const text = chanceClaimText(numbers, "Home FC", ["Ada Home"]);
  assert.match(text.en, /a 6-pass move from their own half, 3 players involved/u);
  assert.equal(guardDraftText("a 6-pass move from their own half, 3 players involved", [text.en], new Set(["Home FC", "Ada Home"])), undefined);
  assert.match(guardDraftText("an 8-pass move from their own half", [text.en], new Set()) ?? "", /number/u);
  assert.match(guardDraftText("a 12-pass move", ["a 123-pass move"], new Set()) ?? "", /Unsupported number token: 12/u);
  assert.equal(guardDraftText("a 12.5 km/h strike", ["a 12.5 km/h strike"], new Set()), undefined);
  assert.match(guardDraftText("a 12 km/h strike", ["a 12.5 km/h strike"], new Set()) ?? "", /Unsupported number token: 12/u);
  assert.equal(guardDraftText("the 72nd minute, 12% of actions", ["the 72nd minute, 12% of actions"], new Set()), undefined);
  assert.match(guardDraftText("minute 72", ["the 72nd minute"], new Set()) ?? "", /Unsupported number token: 72/u);
  assert.match(guardDraftText("Zara Quinn scored", ["Ada Home scored"], new Set(["Ada Home", "Home FC"])) ?? "", /Unsupported proper name: Zara/u);
  assert.equal(guardDraftText("The move started in January for Home FC.", ["Home FC scored"], new Set(["Home FC"])), undefined);
});

test("title-case headlines allow listed football words and reject invented names", () => {
  const claims = ["Fiske scored for Northbridge."];
  const names = new Set(["Fiske", "Northbridge"]);
  assert.equal(guardDraftText("Fiske Scores to Level for Northbridge", claims, names), undefined);
  assert.equal(guardDraftText("Fiske Levels the Match", claims, names), undefined);
  assert.equal(guardDraftText("Fiske Matches Northbridge", claims, names), undefined);
  assert.equal(guardDraftText("Fiske Equalises for Northbridge", claims, names), undefined);
  assert.equal(guardDraftText("Late Winner from Fiske", claims, names), undefined);
  assert.equal(guardDraftText("Late Goal Wins it for Fiske", claims, names), undefined);
  assert.equal(guardDraftText("Late Winner Matches Northbridge Comeback", claims, names), undefined);
  assert.equal(guardDraftText("Fiske Screamer", ["Fiske hit a screamer"], names), undefined);
  assert.match(guardDraftText("Fiske Thunders", ["Fiske thundered the ball"], names) ?? "", /Unsupported proper name: Thunders/u);
  assert.match(guardDraftText("Fiske Screamer", claims, names) ?? "", /Unsupported proper name: Screamer/u);
  assert.match(guardDraftText("Young Scores for Northbridge", claims, names) ?? "", /Unsupported proper name: Young/u);
  assert.match(guardDraftText("Hope Scores for Northbridge", ["Fiske hoped for Northbridge"], names) ?? "", /Unsupported proper name: Hope/u);
  assert.match(guardDraftText("Stone Scores for Northbridge", ["Fiske stoned for Northbridge"], names) ?? "", /Unsupported proper name: Stone/u);
  assert.match(guardDraftText("Cross Scores for Northbridge", claims, names) ?? "", /Unsupported proper name: Cross/u);
  assert.match(guardDraftText("Swift Scores for Northbridge", claims, names) ?? "", /Unsupported proper name: Swift/u);
  assert.match(guardDraftText("Fiske Scores for United", claims, names) ?? "", /Unsupported proper name: United/u);
  assert.match(guardDraftText("Arsenal Scores", claims, names) ?? "", /Unsupported proper name: Arsenal/u);
  assert.match(guardDraftText("Fiske Scores for Liverpool", claims, names) ?? "", /Unsupported proper name: Liverpool/u);
  assert.match(guardDraftText("Brace Scores for Northbridge", claims, names) ?? "", /Unsupported proper name: Brace/u);
  assert.match(guardDraftText("Winner Scores for Northbridge", claims, names) ?? "", /Unsupported proper name: Winner/u);
  assert.match(guardDraftText("The Header Scores for Northbridge", claims, names) ?? "", /Unsupported proper name: Header/u);
  assert.match(guardDraftText("Fiske Scores: Brace Scores for Northbridge", claims, names) ?? "", /Unsupported proper name: Brace/u);
  assert.match(guardDraftText("Fiske Scores. Winner Scores for Northbridge", claims, names) ?? "", /Unsupported proper name: Winner/u);
  assert.match(guardDraftText("Fiske Scores Brace Scores for Northbridge", claims, names) ?? "", /Unsupported proper name: Brace/u);
  assert.match(guardDraftText("Fiske - Winner Scores", claims, names) ?? "", /Unsupported proper name: Winner/u);
  assert.match(guardDraftText("Zara Quinn Scores Late Winner", claims, names) ?? "", /Unsupported proper name: Zara/u);
  assert.match(guardDraftText("Zara Quinn scored", ["Ada Home scored"], new Set(["Ada Home", "Home FC"])) ?? "", /Unsupported proper name: Zara/u);
  assert.equal(guardDraftText("The move started in January for Home FC.", ["Home FC scored"], new Set(["Home FC"])), undefined);
  assert.match(guardDraftText("May Scores for Northbridge", claims, names) ?? "", /Unsupported proper name: May/u);
});

test("production storyline headlines pass and sentence case is strict mid-clause", () => {
  const claims = ["Leo Arden scored for Rivergate FC in the 50th minute to level the match."];
  const names = new Set(["Leo Arden", "Rivergate FC", "Northbridge"]);
  assert.equal(guardDraftText("Leo Arden Levels Score for Rivergate FC", claims, names), undefined);
  assert.equal(guardDraftText("Narrow Lead for Rivergate FC at the Break", claims, names), undefined);
  assert.equal(guardDraftText("Leo Arden Scores Like His Father", claims, names), undefined);
  assert.equal(guardDraftText("Echoing an Old Rivalry, Arden Levels It", claims, names), undefined);
  assert.equal(guardDraftText("Leo Arden levels the score for Rivergate FC", claims, names), undefined);
  assert.equal(guardDraftText("Narrow lead for Rivergate FC at the break", claims, names), undefined);
  assert.match(guardDraftText("Leo Arden levels after Hope crossed", claims, names) ?? "", /Unsupported proper name: Hope/u);
  assert.match(guardDraftText("Rivergate FC level through Narrow", claims, names) ?? "", /Unsupported proper name: Narrow/u);
  assert.match(guardDraftText("Young scores for Rivergate FC", claims, names) ?? "", /Unsupported proper name: Young/u);
  assert.match(guardDraftText("Arden Levels Young Scores", claims, names) ?? "", /Unsupported proper name: Young/u);
  assert.match(guardDraftText("Brace Levels for Rivergate FC", claims, names) ?? "", /Unsupported proper name: Brace/u);
  assert.match(guardDraftText("Late Winner Scores for Northbridge", ["Fiske scored for Northbridge."], names) ?? "", /Unsupported proper name: Winner/u);
  assert.equal(guardDraftText("Nico Hale scores his 49th in the 17th minute", ["17' Nico Hale scored.", "Nico Hale now has 49 documented career goals."], new Set(["Nico Hale"])), undefined);
  assert.match(guardDraftText("Nico Hale scores his 50th", ["Nico Hale now has 49 documented career goals."], new Set(["Nico Hale"])) ?? "", /Unsupported number token: 50th/u);
});

test("verifier accepts a computed chance claim and rejects a mismatched number", () => {
  const shot = event({ id: "shot-1", minute: 8, second: 5, type: "shot", teamId: "home", playerId: "home-p9", outcome: "saved", x: 84, y: 40 });
  const events = [
    event({ id: "kick", minute: 0, second: 0, type: "kickoff", teamId: "home", playerId: "home-p9" }),
    event({ id: "pass-1", minute: 8, second: 0, type: "pass", teamId: "home", playerId: "home-p9", outcome: "complete", x: 20, y: 40, endX: 40, endY: 40 }),
    shot,
  ];
  const match = fixture(events);
  const proposal = buildChanceSequenceProposal(match, shot, 485);
  if (!proposal || proposal.kind !== "chance_sequence") {
    assert.fail("expected a chance_sequence proposal");
  }
  const archive = getArchive();
  const context = { event: shot, fixture: match, matchId: "match-chance", clockSecond: 485, score: { home: 0, away: 0 } };
  const accepted = verifyClaimProposal(archive, buildArchiveIndexes(archive), match, context, "story", "2026-01-01T00:00:00.000Z", proposal);
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.claim.kind, "chance_sequence");
    assert.match(accepted.claim.text.en, /Home FC/u);
    assert.match(accepted.claim.text.en, /Ada Home/u);
  }
  assert.equal(proposal.kind, "chance_sequence");
  const tampered = { ...proposal, params: { ...proposal.params, passes: proposal.params.passes + 1 } };
  const rejected = verifyClaimProposal(archive, buildArchiveIndexes(archive), match, context, "story", "2026-01-01T00:00:00.000Z", tampered);
  assert.equal(rejected.ok, false);
});

test("a withdrawn chance insight retracts the linked storyline", async () => {
  const shot = event({ id: "shot-1", minute: 8, second: 5, type: "goal", teamId: "home", playerId: "home-p9", outcome: "success", x: 90, y: 40 });
  const matchView = view([
    event({ id: "kick", minute: 0, second: 0, type: "kickoff", teamId: "home", playerId: "home-p9" }),
    shot,
  ]);
  const desk = createStorylineDesk({
    archive: getArchive(),
    runner: { configured: () => false, health: () => ({ mode: "unconfigured", agents: [] }) } as unknown as AgentRunner,
  });
  desk.onEvent(matchView, shot);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const created = desk.list(matchView.matchId)[0];
  assert.equal(created?.insightId, chanceInsightId(shot.id));
  const insight: ChanceInsight = {
    insightId: chanceInsightId(shot.id),
    revision: 2,
    matchId: matchView.matchId,
    status: "withdrawn",
    effectiveSecond: 490,
    evidenceEventIds: [{ eventId: shot.id, revision: 2 }],
    metricVersion: "chance-sequence/1",
    coverageNotes: [],
    sequence: null,
    territory: null,
    summaryFacts: [],
    withdrawalReason: "Shot or goal was rescinded",
  };
  desk.applyChanceInsight?.(insight);
  const retracted = desk.list(matchView.matchId)[0];
  assert.equal(retracted?.status, "retracted");
  assert.equal(retracted?.retractionReason, "Shot or goal was rescinded");
  assert.equal(retracted?.insightStatus, "withdrawn");
});

function snapshot(fixtureEvents: MatchFixture, atSecond: number): MatchSnapshot {
  return {
    fixtureId: fixtureEvents.id,
    atSecond,
    stateVersion: "test",
    persona: "analyst",
    language: "en",
    score: { home: 0, away: 0 },
    stats: {
      home: { goals: 0, shots: 0, passes: 0, completedPasses: 0, passAccuracy: 0, corners: 0, tackles: 0, pressureEvents: 0, fouls: 0, yellowCards: 0, redCards: 0, illustrativeXg: 0 },
      away: { goals: 0, shots: 0, passes: 0, completedPasses: 0, passAccuracy: 0, corners: 0, tackles: 0, pressureEvents: 0, fouls: 0, yellowCards: 0, redCards: 0, illustrativeXg: 0 },
    },
    stories: [],
    recentEvents: [],
    evidence: {},
    corrections: [],
    eventCount: fixtureEvents.events.length,
    evidenceCoverage: 1,
    synthetic: true,
  };
}

class QuietDesk implements StorylineDesk {
  onEvent(): void {}
  list(): ReturnType<StorylineDesk["list"]> { return []; }
  facts(): ReturnType<StorylineDesk["facts"]> { return []; }
  review(): ReturnType<StorylineDesk["review"]> { return Promise.reject(new Error("unused")); }
  storyboard(): ReturnType<StorylineDesk["storyboard"]> { return { matchId: "match-chance", stateVersion: "0", chapters: [] }; }
  subscribe(): () => void { return () => {}; }
  health(): ReturnType<StorylineDesk["health"]> { return { mode: "unconfigured", agents: [], retrieval: "unconfigured" }; }
}

function stubLive(current: LiveMatchView): LiveService {
  const listeners = new Set<LiveListener>();
  const status = () => ({
    state: "running" as const,
    transport: "local" as const,
    transportConfigured: false,
    matchId: current.matchId,
    fixtureId: current.fixture.id,
    title: current.fixture.title,
    clockSecond: current.clockSecond,
    speed: 1,
    eventsReceived: current.fixture.events.length,
    duplicatesIgnored: 0,
    stress: false,
  });
  return {
    status,
    current: () => current,
    async start() { return status(); },
    async stop() { return status(); },
    async publishCorrection() {},
    addListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {},
  };
}

async function withServer(app: express.Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("insights route and SSE expose issued, revised and withdrawn records", async () => {
  const shot = event({ id: "shot-1", minute: 8, second: 5, type: "shot", teamId: "home", playerId: "home-p9", outcome: "saved", x: 80, y: 40 });
  const matchView = view([
    event({ id: "pass-1", minute: 8, second: 0, type: "pass", teamId: "home", playerId: "home-p9", outcome: "complete", x: 30, y: 40, endX: 50, endY: 40 }),
    shot,
  ]);
  const insights = createChanceInsightFeed();
  insights.onMatchStart?.(matchView);
  insights.onEvent(matchView, shot);
  const app = express();
  app.use(createLiveRouter({
    live: stubLive(matchView),
    desk: new QuietDesk(),
    analyzeFixture: (current) => snapshot(current, 0),
    insights,
  }));

  await withServer(app, async (baseUrl) => {
    const listed = await fetch(`${baseUrl}/api/live/insights?role=fan`);
    assert.equal(listed.status, 200);
    const body = await listed.json() as ChanceInsight[];
    assert.equal(body[0]?.status, "issued");
    assert.equal(body[0]?.metricVersion, "chance-sequence/1");
    const rejected = await fetch(`${baseUrl}/api/live/insights?role=public`);
    assert.equal(rejected.status, 400);

    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/live/stream?role=studio&persona=analyst&language=en`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    if (!stream.body) {
      assert.fail("missing stream body");
    }
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const messages: LiveMessage[] = [];
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !messages.some((message) => message.type === "insight")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = raw.split("\n").find((entry) => entry.startsWith("data: "));
        if (line) {
          const parsed: unknown = JSON.parse(line.slice(6));
          assert.equal(isLiveMessage(parsed), true);
          if (isLiveMessage(parsed)) messages.push(parsed);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    const issued = messages.find((message) => message.type === "insight");
    assert.equal(issued?.type, "insight");
    if (issued?.type === "insight") {
      assert.equal(issued.insight.status, "issued");
      assert.equal(issued.insight.sequence?.inferred, true);
    }
    await reader.cancel().catch(() => undefined);
    controller.abort();
  });
});

function approvingRunner(): AgentRunner {
  const copy = {
    headline: "Ada Home scores",
    onAirLine: "Ada Home scored for Home FC.",
    overlay: "ada home",
    priority: 80,
  };
  const localized = { headline: copy.headline, onAirLine: copy.onAirLine, overlay: copy.overlay };
  return {
    configured: () => true,
    health: () => ({ mode: "foundry-agents", agents: [] }),
    async research() {
      return [{ kind: "live_event", params: { eventId: "shot-1" }, sources: [{ type: "event", id: "shot-1" }] }];
    },
    async produce() {
      return copy;
    },
    async factCheck() {
      return { verdict: "pass", issues: [] };
    },
    async localize() {
      return { es: localized, fr: localized, pt: localized };
    },
  };
}

function sseSession(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  const messages: LiveMessage[] = [];
  return {
    messages,
    async until(accept: (message: LiveMessage) => boolean, timeoutMs = 3_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !messages.some(accept)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const line = raw.split("\n").find((entry) => entry.startsWith("data: "));
          if (line) {
            const parsed: unknown = JSON.parse(line.slice(6));
            assert.equal(isLiveMessage(parsed), true);
            if (isLiveMessage(parsed)) messages.push(parsed);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    },
  };
}

test("a connected fan receives a fact retraction when a published chance insight is revised", async () => {
  const shot = event({ id: "shot-1", minute: 8, second: 5, type: "goal", teamId: "home", playerId: "home-p9", outcome: "success", x: 90, y: 40 });
  const matchView = view([
    event({ id: "kick", minute: 0, second: 0, type: "kickoff", teamId: "home", playerId: "home-p9" }),
    shot,
  ]);
  const desk = createStorylineDesk({ archive: getArchive(), runner: approvingRunner() });
  const insights = createChanceInsightFeed();
  insights.subscribe((insight) => desk.applyChanceInsight?.(insight));
  insights.onMatchStart?.(matchView);
  insights.onEvent(matchView, shot);
  desk.onEvent(matchView, shot);
  const started = Date.now();
  while (Date.now() - started < 2_000 && desk.list(matchView.matchId)[0]?.status !== "needs_review") {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const created = desk.list(matchView.matchId)[0];
  assert.equal(created?.status, "needs_review", created?.failureReason);
  assert.ok(desk.facts(matchView.matchId).some((fact) => fact.storylineId === created?.id && !fact.retracted));

  const app = express();
  app.use(createLiveRouter({
    live: stubLive(matchView),
    desk,
    analyzeFixture: (current) => snapshot(current, 0),
    insights,
  }));

  await withServer(app, async (baseUrl) => {
    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/live/stream?role=fan&persona=casual&language=en`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    if (!stream.body) assert.fail("missing stream body");
    const reader = stream.body.getReader();
    const session = sseSession(reader);
    await desk.review(created.id, { decision: "approve" });
    await session.until((message) => message.type === "fact" && message.fact.retracted !== true);
    const liveFact = session.messages.find((message): message is Extract<LiveMessage, { type: "fact" }> => message.type === "fact" && message.fact.retracted !== true);
    assert.ok(liveFact, "connected fan did not receive the published fact");
    const factId = liveFact.fact.id;
    const publishedAt = session.messages.indexOf(liveFact);

    const revised = insights.list(matchView.matchId)[0];
    assert.ok(revised);
    desk.applyChanceInsight?.({
      ...revised,
      revision: revised.revision + 1,
      status: "revised",
      revisionReason: "Contributing event revised",
    });

    await session.until((message) => message.type === "fact" && message.fact.id === factId && message.fact.retracted === true);
    const retraction = session.messages.find((message): message is Extract<LiveMessage, { type: "fact" }> => message.type === "fact" && message.fact.id === factId && message.fact.retracted === true);
    assert.ok(retraction, "connected fan did not receive the fact retraction");
    assert.equal((retraction.fact as VerifiedFact).retracted, true);
    assert.ok(session.messages.indexOf(retraction) > publishedAt, "retraction must follow the published fact on the same connection");
    assert.equal(desk.list(matchView.matchId)[0]?.status, "needs_review");
    assert.ok(desk.facts(matchView.matchId).filter((fact) => fact.storylineId === created.id).every((fact) => fact.retracted === true));
    await reader.cancel().catch(() => undefined);
    controller.abort();
  });
});
