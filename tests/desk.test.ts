import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import type {
  ArchiveSnapshot,
  ClaimSource,
  ReviewStorylineRequest,
} from "../shared/platform.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";
import type { LiveMatchView, LiveService } from "../server/contracts.js";
import { createStorylineDesk, type AgentRunner } from "../server/desk/index.js";
import { buildArchiveIndexes, verifyClaimProposal, type ClaimProposal } from "../server/desk/claims.js";
import { createStudioRouter } from "../server/routes/studio.js";
import { HttpError } from "../server/validation.js";

type ProducerDraft = Awaited<ReturnType<AgentRunner["produce"]>>;
type FactCheckResult = Awaited<ReturnType<AgentRunner["factCheck"]>>;
type LocalizationDraft = Awaited<ReturnType<AgentRunner["localize"]>>;

function archive(): ArchiveSnapshot {
  return {
    version: "test-v1",
    clubs: [
      {
        id: "club-rivergate",
        name: "Rivergate FC",
        shortName: "RIV",
        city: "Rivergate",
        stadium: "Harbor End",
        founded: 1898,
        honours: [{ id: "honour-cup-2006", competition: "Cup", season: "2006", result: "winner", finalMatchId: "match-final-2006" }],
      },
      {
        id: "club-northbridge",
        name: "Northbridge Athletic",
        shortName: "NBR",
        city: "Northbridge",
        stadium: "Bridge Ground",
        founded: 1904,
        honours: [],
      },
      {
        id: "club-eastford",
        name: "Eastford City",
        shortName: "EAS",
        city: "Eastford",
        stadium: "City Park",
        founded: 1911,
        honours: [],
      },
    ],
    people: [
      {
        id: "person-ilias",
        name: "Ilias Rowan",
        birthYear: 2001,
        hometown: "Rivergate",
        position: "ST",
        currentClubId: "club-rivergate",
        career: [
          { clubId: "club-northbridge", fromYear: 2019, toYear: 2021, appearances: 88, goals: 18 },
          { clubId: "club-rivergate", fromYear: 2022, toYear: null, appearances: 61, goals: 12 },
        ],
        relations: [{ kind: "parent", personId: "person-mara" }],
        retired: false,
      },
      {
        id: "person-mara",
        name: "Mara Rowan",
        birthYear: 1979,
        hometown: "Rivergate",
        position: "FW",
        currentClubId: null,
        career: [
          { clubId: "club-rivergate", fromYear: 1999, toYear: 2008, appearances: 180, goals: 54 },
        ],
        relations: [{ kind: "child", personId: "person-ilias" }],
        retired: true,
      },
      {
        id: "person-jude",
        name: "Jude Asher",
        birthYear: 1998,
        hometown: "Northbridge",
        position: "MF",
        currentClubId: "club-northbridge",
        career: [{ clubId: "club-northbridge", fromYear: 2018, toYear: null, appearances: 152, goals: 21 }],
        relations: [],
        retired: false,
      },
    ],
    matches: [
      {
        id: "match-final-2006",
        date: "2006-05-21",
        season: "2006",
        competition: "Cup",
        stage: "final",
        homeClubId: "club-rivergate",
        awayClubId: "club-northbridge",
        homeScore: 2,
        awayScore: 1,
        venue: "Harbor End",
        goals: [
          { personId: "person-mara", clubId: "club-rivergate", minute: 72 },
          { personId: "person-mara", clubId: "club-rivergate", minute: 84 },
        ],
      },
      {
        id: "match-h2h-1",
        date: "2008-09-02",
        season: "2008",
        competition: "League",
        stage: "league",
        homeClubId: "club-rivergate",
        awayClubId: "club-northbridge",
        homeScore: 1,
        awayScore: 1,
        venue: "Harbor End",
        goals: [],
      },
      {
        id: "match-h2h-2",
        date: "2010-02-14",
        season: "2010",
        competition: "League",
        stage: "league",
        homeClubId: "club-northbridge",
        awayClubId: "club-rivergate",
        homeScore: 0,
        awayScore: 2,
        venue: "Bridge Ground",
        goals: [],
      },
      {
        id: "match-h2h-3",
        date: "2012-11-10",
        season: "2012",
        competition: "League",
        stage: "league",
        homeClubId: "club-northbridge",
        awayClubId: "club-rivergate",
        homeScore: 3,
        awayScore: 0,
        venue: "Bridge Ground",
        goals: [],
      },
      {
        id: "match-h2h-4",
        date: "2014-03-18",
        season: "2014",
        competition: "League",
        stage: "league",
        homeClubId: "club-rivergate",
        awayClubId: "club-northbridge",
        homeScore: 1,
        awayScore: 0,
        venue: "Harbor End",
        goals: [
          { personId: "person-ilias", clubId: "club-rivergate", minute: 12 },
          { personId: "person-ilias", clubId: "club-rivergate", minute: 68 },
        ],
      },
    ],
    documents: [
      {
        id: "doc-family-1",
        title: "Rowan family note",
        body: "Mara Rowan scored for Rivergate in the 2006 Cup final against Northbridge Athletic.",
        kind: "family_note",
        recordIds: ["person-ilias", "person-mara", "match-final-2006"],
      },
      {
        id: "doc-player-1",
        title: "Ilias Rowan profile",
        body: "Ilias Rowan joined Rivergate after an 18-goal spell at Northbridge Athletic.",
        kind: "player_profile",
        recordIds: ["person-ilias", "club-northbridge", "club-rivergate"],
      },
    ],
  };
}

function event(input: Partial<MatchEvent> & Pick<MatchEvent, "id" | "minute" | "second" | "type" | "teamId" | "playerId">): MatchEvent {
  return {
    revision: 1,
    outcome: "none",
    x: 50,
    y: 50,
    ...input,
  };
}

function fixture(events: MatchEvent[] = []): MatchFixture {
  return {
    id: "fixture-rivergate",
    seed: 11,
    title: "Rivergate FC vs Northbridge Athletic",
    description: "Synthetic fixture",
    home: {
      id: "home",
      name: "Rivergate FC",
      shortName: "RIV",
      archiveClubId: "club-rivergate",
      players: [
        { id: "home-p1", name: "Milo Hart", number: 1, position: "GK", teamId: "home" },
        { id: "home-p9", name: "Ilias Rowan", number: 9, position: "ST", teamId: "home", archiveId: "person-ilias" },
      ],
    },
    away: {
      id: "away",
      name: "Northbridge Athletic",
      shortName: "NBR",
      archiveClubId: "club-northbridge",
      players: [
        { id: "away-p8", name: "Jude Asher", number: 8, position: "MF", teamId: "away", archiveId: "person-jude" },
      ],
    },
    events,
    durationSeconds: 5400,
    correctionEventId: "goal-home-72",
    correctionAvailableAt: 4500,
  };
}

function liveView(events: MatchEvent[], clockSecond = Math.max(...events.map((current) => current.minute * 60 + current.second))): LiveMatchView {
  return {
    matchId: "match-live-1",
    fixture: fixture(events),
    clockSecond,
  };
}

function source(type: ClaimSource["type"], id: string): ClaimSource {
  return { type, id };
}

function proposal(kind: ClaimProposal["kind"], params: ClaimProposal["params"], sources: ClaimSource[]): ClaimProposal {
  return { kind, params, sources } as ClaimProposal;
}

class FakeRunner implements AgentRunner {
  researchQueue: Array<ClaimProposal[] | Promise<ClaimProposal[]>> = [];
  produceQueue: Array<ProducerDraft | Promise<ProducerDraft>> = [];
  factCheckQueue: Array<FactCheckResult | Promise<FactCheckResult>> = [];
  localizeQueue: Array<LocalizationDraft | Promise<LocalizationDraft>> = [];
  readonly calls = { research: 0, produce: 0, factCheck: 0, localize: 0 };

  configured() {
    return true;
  }

  health() {
    return { mode: "foundry-agents" as const, agents: ["matchlens-researcher", "matchlens-producer", "matchlens-fact-checker", "matchlens-localizer"] };
  }

  async research(): Promise<ClaimProposal[]> {
    this.calls.research += 1;
    return await Promise.resolve(this.researchQueue.shift() ?? []);
  }

  async produce(): Promise<ProducerDraft> {
    this.calls.produce += 1;
    const next = this.produceQueue.shift();
    if (!next) {
      throw new Error("No fake produce response queued");
    }
    return await Promise.resolve(next);
  }

  async factCheck(): Promise<FactCheckResult> {
    this.calls.factCheck += 1;
    return await Promise.resolve(this.factCheckQueue.shift() ?? ({ verdict: "pass", issues: [] } satisfies FactCheckResult));
  }

  async localize(): Promise<LocalizationDraft> {
    this.calls.localize += 1;
    const next = this.localizeQueue.shift();
    if (!next) {
      throw new Error("No fake localization response queued");
    }
    return await Promise.resolve(next);
  }
}

class UnconfiguredRunner implements AgentRunner {
  configured() {
    return false;
  }

  health() {
    return { mode: "unconfigured" as const, agents: ["matchlens-researcher", "matchlens-producer", "matchlens-fact-checker", "matchlens-localizer"] };
  }

  async research(): Promise<ClaimProposal[]> {
    throw new Error("Storyline agents are not configured");
  }

  async produce(): Promise<ProducerDraft> {
    throw new Error("Storyline agents are not configured");
  }

  async factCheck(): Promise<FactCheckResult> {
    throw new Error("Storyline agents are not configured");
  }

  async localize(): Promise<LocalizationDraft> {
    throw new Error("Storyline agents are not configured");
  }
}

function localizationDraft(): LocalizationDraft {
  return {
    es: {
      headline: "Ilias Rowan y 2006",
      onAirLine: "Ilias Rowan y Jude Asher aparecen con Mara Rowan, Rivergate FC, Northbridge Athletic y 2006.",
      overlay: "Ilias Rowan 2006",
    },
    fr: {
      headline: "Ilias Rowan et 2006",
      onAirLine: "Ilias Rowan et Jude Asher apparaissent avec Mara Rowan, Rivergate FC, Northbridge Athletic et 2006.",
      overlay: "Ilias Rowan 2006",
    },
  };
}

function producerDraft(headline = "Rowan links 2006 to now", onAirLine = "Ilias Rowan scored, and his mother Mara Rowan scored for Rivergate in the 2006 Cup final against Northbridge Athletic.", overlay = "rowan echoes 2006", priority = 91): ProducerDraft {
  return { headline, onAirLine, overlay, priority };
}

async function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function triggerGoalEvents(): MatchEvent[] {
  return [
    event({ id: "kickoff", minute: 0, second: 0, type: "kickoff", teamId: "home", playerId: "home-p9" }),
    event({ id: "goal-home-72", minute: 72, second: 15, type: "goal", teamId: "home", playerId: "home-p9", outcome: "success", x: 94, y: 48 }),
    event({ id: "fulltime", minute: 90, second: 0, type: "fulltime", teamId: "home", playerId: "home-p1" }),
  ];
}

test("verifier accepts and rejects every claim kind deterministically", () => {
  const syntheticArchive = archive();
  const indexes = buildArchiveIndexes(syntheticArchive);
  const events = [
    ...triggerGoalEvents(),
    event({ id: "red-away-80", minute: 80, second: 5, type: "red_card", teamId: "away", playerId: "away-p8" }),
    event({ id: "rescinded-goal", minute: 70, second: 0, type: "goal", teamId: "away", playerId: "away-p8", rescinded: true }),
    event({ id: "future-goal", minute: 88, second: 0, type: "goal", teamId: "away", playerId: "away-p8" }),
  ];
  const view = liveView(events, 80 * 60 + 5);
  const context = {
    event: events[1],
    fixture: view.fixture,
    matchId: view.matchId,
    clockSecond: view.clockSecond,
    score: { home: 1, away: 0 },
  };

  const accepted = [
    proposal("live_event", { eventId: "goal-home-72" }, [source("event", "goal-home-72")]),
    proposal("match_state", { eventIds: ["goal-home-72"] }, [source("event", "goal-home-72")]),
    proposal("former_club", { personId: "person-ilias", clubId: "club-northbridge", fromYear: 2019, toYear: 2021, goals: 18 }, [source("archive", "person-ilias")]),
    proposal("family_link", { personId: "person-ilias", relativeId: "person-mara", relation: "parent", matchId: "match-final-2006", opponentClubId: "club-northbridge" }, [source("archive", "person-mara")]),
    proposal("career_goals", { personId: "person-ilias", total: 31 }, [source("archive", "person-ilias"), source("event", "goal-home-72")]),
    proposal("head_to_head", { clubAId: "club-rivergate", clubBId: "club-northbridge", clubAWins: 3, clubBWins: 1, draws: 1 }, [source("archive", "club-rivergate")]),
    proposal("historic_final", { matchId: "match-final-2006" }, [source("archive", "match-final-2006")]),
    proposal("club_honour", { clubId: "club-rivergate", honourId: "honour-cup-2006" }, [source("archive", "honour-cup-2006")]),
  ];

  for (const item of accepted) {
    const result = verifyClaimProposal(syntheticArchive, indexes, view.fixture, context, "story-1", "2026-01-01T00:00:00.000Z", item);
    assert.equal(result.ok, true, item.kind);
    if (result.ok) {
      assert.ok(result.claim.text.en.length > 0);
      assert.ok(result.claim.text.es.length > 0);
      assert.ok(result.claim.text.fr.length > 0);
    }
  }

  const rejected = [
    proposal("family_link", { personId: "person-ilias", relativeId: "person-mara", relation: "sibling", matchId: "match-final-2006" }, [source("archive", "person-mara")]),
    proposal("former_club", { personId: "person-ilias", clubId: "club-northbridge", fromYear: 2018, toYear: 2021, goals: 18 }, [source("archive", "person-ilias")]),
    proposal("career_goals", { personId: "person-ilias", total: 99 }, [source("archive", "person-ilias")]),
    proposal("live_event", { eventId: "future-goal" }, [source("event", "future-goal")]),
    proposal("match_state", { eventIds: ["rescinded-goal"] }, [source("event", "rescinded-goal")]),
    proposal("club_honour", { clubId: "club-rivergate", honourId: "missing-honour" }, [source("archive", "missing-honour")]),
  ];

  for (const item of rejected) {
    const result = verifyClaimProposal(syntheticArchive, indexes, view.fixture, context, "story-1", "2026-01-01T00:00:00.000Z", item);
    assert.equal(result.ok, false, item.kind);
  }
});

test("claim text is rendered from archive records in English, Spanish, and French", () => {
  const syntheticArchive = archive();
  const indexes = buildArchiveIndexes(syntheticArchive);
  const events = triggerGoalEvents();
  const context = {
    event: events[1],
    fixture: fixture(events),
    matchId: "match-live-1",
    clockSecond: 72 * 60 + 15,
    score: { home: 1, away: 0 },
  };
  const result = verifyClaimProposal(
    syntheticArchive,
    indexes,
    context.fixture,
    context,
    "story-1",
    "2026-01-01T00:00:00.000Z",
    proposal("family_link", {
      personId: "person-ilias",
      relativeId: "person-mara",
      relation: "parent",
      matchId: "match-final-2006",
      opponentClubId: "club-northbridge",
    }, [source("archive", "person-mara")]),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.claim.text.en, /Mara Rowan/u);
    assert.match(result.claim.text.es, /Mara Rowan/u);
    assert.match(result.claim.text.fr, /Mara Rowan/u);
  }
});

test("pipeline happy path emits facts, statuses, and trace roles", async () => {
  const runner = new FakeRunner();
  runner.researchQueue.push([
    proposal("live_event", { eventId: "goal-home-72" }, [source("event", "goal-home-72")]),
    proposal("family_link", { personId: "person-ilias", relativeId: "person-mara", relation: "parent", matchId: "match-final-2006", opponentClubId: "club-northbridge" }, [source("archive", "person-mara")]),
    proposal("career_goals", { personId: "person-ilias", total: 31 }, [source("archive", "person-ilias"), source("event", "goal-home-72")]),
  ]);
  runner.produceQueue.push(producerDraft());
  runner.factCheckQueue.push({ verdict: "pass", issues: [] });
  runner.localizeQueue.push(localizationDraft());
  const desk = createStorylineDesk({ archive: archive(), runner });
  const updates: string[] = [];
  desk.subscribe((update) => {
    if (update.storyline) {
      updates.push(`storyline:${update.storyline.status}`);
    }
    if (update.fact) {
      updates.push(`fact:${update.fact.id}`);
    }
  });

  const view = liveView(triggerGoalEvents());
  desk.onEvent(view, view.fixture.events[1]);

  await waitFor(() => {
    const current = desk.list(view.matchId)[0];
    assert.equal(current.status, "needs_review");
  });

  const storyline = desk.list(view.matchId)[0];
  // Three researched claims plus the live analyst's automatic scoreline claim.
  assert.equal(storyline.claims.filter((claim) => claim.status === "verified").length, 4);
  assert.ok(storyline.claims.some((claim) => claim.kind === "match_state" && /The goal (levelled|put|extended|reduced)/u.test(claim.text.en)));
  assert.deepEqual(storyline.trace.map((step) => step.role), ["researcher", "verifier", "producer", "fact-checker", "localizer"]);
  assert.ok(desk.facts(view.matchId).length >= 3);
  assert.ok(updates.some((item) => item.startsWith("fact:")));
});

test("producer guard rejects invented name then succeeds on retry", async () => {
  const runner = new FakeRunner();
  runner.researchQueue.push([proposal("live_event", { eventId: "goal-home-72" }, [source("event", "goal-home-72")])]);
  runner.produceQueue.push(
    producerDraft("Jude Asher arrives", "Jude Asher scored for Rivergate FC.", "jude asher"),
    producerDraft("Rowan scores", "Ilias Rowan scored for Rivergate FC.", "rowan scores", 88),
  );
  runner.factCheckQueue.push({ verdict: "pass", issues: [] });
  runner.localizeQueue.push(localizationDraft());
  const desk = createStorylineDesk({ archive: archive(), runner });
  const view = liveView(triggerGoalEvents());
  desk.onEvent(view, view.fixture.events[1]);

  await waitFor(() => {
    assert.equal(desk.list(view.matchId)[0].status, "needs_review");
  });
  assert.equal(runner.calls.produce, 2);
  assert.equal(desk.list(view.matchId)[0].headline.en, "Rowan scores");
});

test("producer guard second failure marks storyline failed", async () => {
  const runner = new FakeRunner();
  runner.researchQueue.push([proposal("live_event", { eventId: "goal-home-72" }, [source("event", "goal-home-72")])]);
  runner.produceQueue.push(
    producerDraft("Jude Asher arrives", "Jude Asher scored for Rivergate FC.", "jude asher"),
    producerDraft("Mara Rowan arrives", "Mara Rowan scored for Rivergate FC.", "mara rowan"),
  );
  const desk = createStorylineDesk({ archive: archive(), runner });
  const view = liveView(triggerGoalEvents());
  desk.onEvent(view, view.fixture.events[1]);

  await waitFor(() => {
    assert.equal(desk.list(view.matchId)[0].status, "failed");
  });
  assert.match(desk.list(view.matchId)[0].failureReason ?? "", /Producer output failed/u);
});

test("producer guard rejects a headline cut off mid-phrase then succeeds on retry", async () => {
  const runner = new FakeRunner();
  runner.researchQueue.push([proposal("live_event", { eventId: "goal-home-72" }, [source("event", "goal-home-72")])]);
  runner.produceQueue.push(
    producerDraft("Ilias Rowan scores, echoing 2006/", "Ilias Rowan scored for Rivergate FC.", "rowan scores"),
    producerDraft("Rowan scores", "Ilias Rowan scored for Rivergate FC.", "rowan scores", 88),
  );
  runner.factCheckQueue.push({ verdict: "pass", issues: [] });
  runner.localizeQueue.push(localizationDraft());
  const desk = createStorylineDesk({ archive: archive(), runner });
  const view = liveView(triggerGoalEvents());
  desk.onEvent(view, view.fixture.events[1]);

  await waitFor(() => {
    assert.equal(desk.list(view.matchId)[0].status, "needs_review");
  });
  assert.equal(runner.calls.produce, 2);
  assert.equal(desk.list(view.matchId)[0].headline.en, "Rowan scores");
});

test("fact-checker revise loop can leave storyline in needs_review", async () => {
  const runner = new FakeRunner();
  runner.researchQueue.push([proposal("live_event", { eventId: "goal-home-72" }, [source("event", "goal-home-72")])]);
  runner.produceQueue.push(
    producerDraft("Rowan scores", "Ilias Rowan scored for Rivergate FC and changed the destiny of the club.", "rowan scores", 75),
    producerDraft("Rowan scores", "Ilias Rowan scored for Rivergate FC.", "rowan scores", 76),
  );
  runner.factCheckQueue.push(
    { verdict: "revise", issues: ["Avoid unsupported causation"] },
    { verdict: "revise", issues: ["Still too strong"] },
  );
  const desk = createStorylineDesk({ archive: archive(), runner });
  const view = liveView(triggerGoalEvents());
  desk.onEvent(view, view.fixture.events[1]);

  await waitFor(() => {
    assert.equal(desk.list(view.matchId)[0].status, "needs_review");
  });
  const trace = desk.list(view.matchId)[0].trace;
  assert.equal(trace.at(-1)?.role, "fact-checker");
  assert.equal(trace.at(-1)?.status, "rejected");
});

test("localizer failure leaves missing language empty and records trace detail", async () => {
  const runner = new FakeRunner();
  runner.researchQueue.push([proposal("live_event", { eventId: "goal-home-72" }, [source("event", "goal-home-72")])]);
  runner.produceQueue.push(producerDraft("Rowan scores", "Ilias Rowan scored for Rivergate FC.", "rowan scores", 70));
  runner.factCheckQueue.push({ verdict: "pass", issues: [] });
  runner.localizeQueue.push(
    {
      es: { headline: "Gol sin nombre", onAirLine: "Marcó para Rivergate FC.", overlay: "sin nombre" },
      fr: { headline: "But Rowan", onAirLine: "Ilias Rowan a marqué pour Rivergate FC.", overlay: "rowan" },
    },
    {
      es: { headline: "Otro intento", onAirLine: "Rivergate FC marcó.", overlay: "otro" },
      fr: { headline: "But Rowan", onAirLine: "Ilias Rowan a marqué pour Rivergate FC.", overlay: "rowan" },
    },
  );
  const desk = createStorylineDesk({ archive: archive(), runner });
  const view = liveView(triggerGoalEvents());
  desk.onEvent(view, view.fixture.events[1]);

  await waitFor(() => {
    assert.equal(desk.list(view.matchId)[0].status, "needs_review");
  });
  const storyline = desk.list(view.matchId)[0];
  assert.equal(storyline.headline.es, "");
  assert.equal(storyline.headline.fr, "But Rowan");
  assert.match(storyline.trace.at(-1)?.detail ?? "", /Translation unavailable/u);
});

test("rescinded revisions retract dependent storylines and facts", async () => {
  const runner = new FakeRunner();
  runner.researchQueue.push([proposal("live_event", { eventId: "goal-home-72" }, [source("event", "goal-home-72")])]);
  runner.produceQueue.push(producerDraft("Rowan scores", "Ilias Rowan scored for Rivergate FC.", "rowan scores", 80));
  runner.factCheckQueue.push({ verdict: "pass", issues: [] });
  runner.localizeQueue.push(localizationDraft());
  const desk = createStorylineDesk({ archive: archive(), runner });
  const view = liveView(triggerGoalEvents());
  desk.onEvent(view, view.fixture.events[1]);

  await waitFor(() => {
    assert.equal(desk.list(view.matchId)[0].status, "needs_review");
  });
  desk.onEvent(view, { ...view.fixture.events[1], revision: 2, rescinded: true });

  await waitFor(() => {
    assert.equal(desk.list(view.matchId)[0].status, "retracted");
  });
  assert.equal(desk.facts(view.matchId)[0].retracted, true);
});

test("review approve, reject, edit and validation errors behave correctly", async () => {
  const runner = new FakeRunner();
  runner.researchQueue.push(
    [proposal("live_event", { eventId: "goal-home-72" }, [source("event", "goal-home-72")])],
    [proposal("live_event", { eventId: "red-away-80" }, [source("event", "red-away-80")])],
  );
  runner.produceQueue.push(
    producerDraft("Rowan scores", "Ilias Rowan scored for Rivergate FC.", "rowan scores", 80),
    producerDraft("Jude dismissed", "Jude Asher was sent off for Northbridge Athletic.", "jude dismissed", 77),
  );
  runner.factCheckQueue.push({ verdict: "pass", issues: [] }, { verdict: "pass", issues: [] });
  runner.localizeQueue.push(localizationDraft(), localizationDraft(), localizationDraft());
  const desk = createStorylineDesk({ archive: archive(), runner });
  const view = liveView([
    ...triggerGoalEvents(),
    event({ id: "red-away-80", minute: 80, second: 5, type: "red_card", teamId: "away", playerId: "away-p8" }),
  ], 90 * 60);

  desk.onEvent(view, view.fixture.events[1]);
  desk.onEvent(view, view.fixture.events[3]);

  await waitFor(() => {
    assert.equal(desk.list(view.matchId).length, 2);
    assert.ok(desk.list(view.matchId).every((item) => item.status === "needs_review"));
  });

  const [first, second] = desk.list(view.matchId);
  const approved = await desk.review(first.id, { decision: "approve" });
  assert.equal(approved.status, "approved");
  await assert.rejects(
    () => desk.review(first.id, { decision: "approve" }),
    (error) => error instanceof HttpError && error.status === 409,
  );
  await assert.rejects(
    () => desk.review(second.id, { decision: "edit", onAirLine: "Ilias Rowan scored 2 goals for Northbridge Athletic." }),
    (error) => error instanceof HttpError && error.status === 400,
  );
  const edited = await desk.review(second.id, { decision: "edit", onAirLine: "Jude Asher was sent off for Northbridge Athletic." });
  assert.equal(edited.status, "approved");

  const runnerReject = new FakeRunner();
  runnerReject.researchQueue.push([proposal("live_event", { eventId: "goal-home-72" }, [source("event", "goal-home-72")])]);
  runnerReject.produceQueue.push(producerDraft("Rowan scores", "Ilias Rowan scored for Rivergate FC.", "rowan scores", 80));
  runnerReject.factCheckQueue.push({ verdict: "pass", issues: [] });
  runnerReject.localizeQueue.push(localizationDraft());
  const rejectDesk = createStorylineDesk({ archive: archive(), runner: runnerReject });
  rejectDesk.onEvent(view, view.fixture.events[1]);
  await waitFor(() => {
    assert.equal(rejectDesk.list(view.matchId)[0].status, "needs_review");
  });
  const rejected = await rejectDesk.review(rejectDesk.list(view.matchId)[0].id, { decision: "reject", note: "Too generic" });
  assert.equal(rejected.status, "rejected");
});

test("budgets and concurrency queue are enforced", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstResearch = new Promise<ClaimProposal[]>((resolve) => {
    releaseFirst = () => resolve([proposal("live_event", { eventId: "goal-home-72" }, [source("event", "goal-home-72")])]);
  });
  const runner = new FakeRunner();
  runner.researchQueue.push(firstResearch, [proposal("live_event", { eventId: "red-away-80" }, [source("event", "red-away-80")])]);
  runner.produceQueue.push(
    producerDraft("Rowan scores", "Ilias Rowan scored for Rivergate FC.", "rowan scores", 80),
    producerDraft("Jude dismissed", "Jude Asher was sent off for Northbridge Athletic.", "jude dismissed", 75),
  );
  runner.factCheckQueue.push({ verdict: "pass", issues: [] }, { verdict: "pass", issues: [] });
  runner.localizeQueue.push(localizationDraft(), localizationDraft());
  const desk = createStorylineDesk({ archive: archive(), runner, maxConcurrent: 1, maxPerMatch: 2 });
  const view = liveView([
    ...triggerGoalEvents(),
    event({ id: "red-away-80", minute: 80, second: 5, type: "red_card", teamId: "away", playerId: "away-p8" }),
    event({ id: "goal-home-85", minute: 85, second: 1, type: "goal", teamId: "home", playerId: "home-p9", outcome: "success" }),
  ], 90 * 60);
  desk.onEvent(view, view.fixture.events[1]);
  desk.onEvent(view, view.fixture.events[3]);
  desk.onEvent(view, view.fixture.events[4]);

  await waitFor(() => {
    assert.equal(desk.list(view.matchId).length, 2);
    assert.equal(runner.calls.research, 1);
  });
  releaseFirst?.();
  await waitFor(() => {
    assert.equal(runner.calls.research, 2);
    assert.ok(desk.list(view.matchId).every((item) => item.status === "needs_review"));
  });
});

test("unconfigured mode produces failed storyline with explicit reason", async () => {
  const desk = createStorylineDesk({ archive: archive(), runner: new UnconfiguredRunner() });
  const view = liveView(triggerGoalEvents());
  desk.onEvent(view, view.fixture.events[1]);
  await waitFor(() => {
    assert.equal(desk.list(view.matchId)[0].status, "failed");
  });
  assert.equal(desk.list(view.matchId)[0].failureReason, "Storyline agents are not configured");
  assert.equal(desk.health().mode, "unconfigured");
});

test("storyboard chapters are generated from event windows and approved storylines", async () => {
  const runner = new FakeRunner();
  runner.researchQueue.push(
    [proposal("live_event", { eventId: "goal-home-72" }, [source("event", "goal-home-72")])],
    [proposal("live_event", { eventId: "red-away-80" }, [source("event", "red-away-80")])],
  );
  runner.produceQueue.push(
    producerDraft("Rowan scores", "Ilias Rowan scored for Rivergate FC.", "rowan scores", 80),
    producerDraft("Jude dismissed", "Jude Asher was sent off for Northbridge Athletic.", "jude dismissed", 70),
  );
  runner.factCheckQueue.push({ verdict: "pass", issues: [] }, { verdict: "pass", issues: [] });
  runner.localizeQueue.push(localizationDraft(), localizationDraft());
  const desk = createStorylineDesk({ archive: archive(), runner });
  const events = [
    event({ id: "kickoff", minute: 0, second: 0, type: "kickoff", teamId: "home", playerId: "home-p9" }),
    event({ id: "goal-home-72", minute: 72, second: 15, type: "goal", teamId: "home", playerId: "home-p9", outcome: "success" }),
    event({ id: "red-away-80", minute: 80, second: 5, type: "red_card", teamId: "away", playerId: "away-p8" }),
    event({ id: "fulltime", minute: 90, second: 0, type: "fulltime", teamId: "home", playerId: "home-p1" }),
  ];
  const view = liveView(events, 90 * 60);
  desk.onEvent(view, events[1]);
  desk.onEvent(view, events[2]);
  await waitFor(() => {
    assert.ok(desk.list(view.matchId).every((item) => item.status === "needs_review"));
  });
  for (const item of desk.list(view.matchId)) {
    await desk.review(item.id, { decision: "approve" });
  }
  const storyboard = desk.storyboard(view);
  assert.equal(storyboard.matchId, view.matchId);
  assert.ok(storyboard.stateVersion.length > 0);
  assert.ok(storyboard.chapters.length >= 3);
  assert.equal(storyboard.chapters[0].title.en, "Kickoff");
  assert.ok(storyboard.chapters.some((chapter) => chapter.storylineIds.length > 0));
});

function createLiveService(currentView?: LiveMatchView): LiveService {
  return {
    status() {
      return {
        state: currentView ? "running" : "idle",
        transport: "local",
        transportConfigured: true,
        clockSecond: currentView?.clockSecond ?? 0,
        speed: 1,
        eventsReceived: currentView?.fixture.events.length ?? 0,
        duplicatesIgnored: 0,
        stress: false,
      };
    },
    current() {
      return currentView;
    },
    async start() {
      return this.status();
    },
    async stop() {
      return this.status();
    },
    async publishCorrection() {},
    addListener() {
      return () => {};
    },
    async close() {},
  };
}

async function withStudioServer(
  live: LiveService,
  desk: ReturnType<typeof createStorylineDesk>,
  handler: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  app.use(createStudioRouter({ desk, live }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    response.status(500).json({ error: "Unexpected server error" });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await handler(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolveServer, rejectServer) => server.close((error) => error ? rejectServer(error) : resolveServer()));
  }
}

test("studio routes expose storylines, facts, review, storyboard, and health", async () => {
  const runner = new FakeRunner();
  runner.researchQueue.push([proposal("live_event", { eventId: "goal-home-72" }, [source("event", "goal-home-72")])]);
  runner.produceQueue.push(producerDraft("Rowan scores", "Ilias Rowan scored for Rivergate FC.", "rowan scores", 80));
  runner.factCheckQueue.push({ verdict: "pass", issues: [] });
  runner.localizeQueue.push(localizationDraft(), localizationDraft());
  const desk = createStorylineDesk({ archive: archive(), runner });
  const view = liveView(triggerGoalEvents());
  desk.onEvent(view, view.fixture.events[1]);
  await waitFor(() => {
    assert.equal(desk.list(view.matchId)[0].status, "needs_review");
  });

  await withStudioServer(createLiveService(view), desk, async (baseUrl) => {
    const storylines = await fetch(`${baseUrl}/api/studio/storylines`).then((response) => response.json());
    assert.equal(storylines.length, 1);
    const facts = await fetch(`${baseUrl}/api/studio/facts`).then((response) => response.json());
    // The researched claim plus the automatic scoreline claim.
    assert.equal(facts.length, 2);
    const health = await fetch(`${baseUrl}/api/studio/health`).then((response) => response.json());
    assert.equal(health.mode, "foundry-agents");
    const storyboard = await fetch(`${baseUrl}/api/studio/storyboard`);
    assert.equal(storyboard.status, 200);
    const reviewed = await fetch(`${baseUrl}/api/studio/storylines/${storylines[0].id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" satisfies ReviewStorylineRequest["decision"] }),
    }).then((response) => response.json());
    assert.equal(reviewed.status, "approved");
  });

  await withStudioServer(createLiveService(undefined), desk, async (baseUrl) => {
    const storylines = await fetch(`${baseUrl}/api/studio/storylines`).then((response) => response.json());
    assert.deepEqual(storylines, []);
    const facts = await fetch(`${baseUrl}/api/studio/facts`).then((response) => response.json());
    assert.deepEqual(facts, []);
    const storyboard = await fetch(`${baseUrl}/api/studio/storyboard`);
    assert.equal(storyboard.status, 404);
  });
});
