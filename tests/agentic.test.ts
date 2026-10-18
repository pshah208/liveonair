import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { ArchiveSnapshot, Storyline } from "../shared/platform.js";
import type { MatchEvent, MatchFixture, MatchSnapshot, StoryCard } from "../shared/types.js";
import { visibleStorylines } from "../server/agentAccess.js";
import { createApp } from "../server/app.js";
import type { LiveMatchView } from "../server/contracts.js";
import { deriveTacticsProposals, type TacticsInput } from "../server/desk/agents/tactics-analyst.js";
import { DESK_AGENT_SPECS } from "../server/desk/agents/index.js";
import type { ClaimProposal } from "../server/desk/claims.js";
import { allowedNext, decideNext } from "../server/desk/coordinator.js";
import { createStorylineDesk, type AgentRunner } from "../server/desk/index.js";
import { CircuitBreaker, GuardRejectError, classifyError } from "../server/desk/recovery.js";
import { createWorkspace, type StorylineWorkspace } from "../server/desk/state.js";
import type { DirectorInput, DirectorProposal } from "../server/desk/coordinator.js";
import { getFixture, listFixtures } from "../server/fixtures.js";

type ProducerDraft = Awaited<ReturnType<AgentRunner["produce"]>>;
type FactCheckResult = Awaited<ReturnType<AgentRunner["factCheck"]>>;
type LocalizationDraft = Awaited<ReturnType<AgentRunner["localize"]>>;
type Queued<T> = T | Promise<T> | Error;

const staticDir = mkdtempSync(resolve(tmpdir(), "matchlens-agentic-test-"));
writeFileSync(resolve(staticDir, "index.html"), "<!doctype html><html><body><div id='root'></div></body></html>", "utf8");

function emptyArchive(): ArchiveSnapshot {
  return { version: "agentic-test", clubs: [], people: [], matches: [], documents: [] };
}

function event(input: Partial<MatchEvent> & Pick<MatchEvent, "id" | "minute" | "type" | "teamId" | "playerId">): MatchEvent {
  return { revision: 1, second: 0, outcome: "none", x: 50, y: 50, ...input };
}

function fixture(): MatchFixture {
  return {
    id: "fixture-agentic",
    seed: 3,
    title: "Blue FC vs Red FC",
    description: "Synthetic fixture",
    home: { id: "home", name: "Blue FC", shortName: "BLU", players: [{ id: "p1", name: "Alice Stone", number: 9, position: "FW", teamId: "home" }] },
    away: { id: "away", name: "Red FC", shortName: "RED", players: [{ id: "p3", name: "Cara Lane", number: 10, position: "FW", teamId: "away" }] },
    events: [
      event({ id: "kickoff", minute: 0, type: "kickoff", teamId: "home", playerId: "p1" }),
      event({ id: "goal-0", minute: 10, type: "goal", teamId: "away", playerId: "p3", outcome: "success" }),
      event({ id: "press-1", minute: 25, type: "pressure", teamId: "home", playerId: "p1" }),
      event({ id: "goal-1", minute: 30, type: "goal", teamId: "home", playerId: "p1", outcome: "success" }),
    ],
    durationSeconds: 5400,
    correctionEventId: "goal-1",
    correctionAvailableAt: 4000,
  };
}

function view(): LiveMatchView {
  return { matchId: "match-agentic", fixture: fixture(), clockSecond: 30 * 60 };
}

const goalClaim: ClaimProposal = { kind: "live_event", params: { eventId: "goal-1" }, sources: [{ type: "event", id: "goal-1" }] };
const goodDraft: ProducerDraft = { headline: "Stone scores for Blue FC", onAirLine: "Alice Stone scored for Blue FC.", overlay: "stone scores", priority: 70 };
const localization: LocalizationDraft = {
  es: { headline: "Gol de Stone para Blue FC", onAirLine: "Alice Stone marcó para Blue FC.", overlay: "gol de stone" },
  fr: { headline: "But de Stone pour Blue FC", onAirLine: "Alice Stone a marqué pour Blue FC.", overlay: "but de stone" },
  pt: { headline: "Gol de Stone pelo Blue FC", onAirLine: "Alice Stone marcou para o Blue FC.", overlay: "gol de stone" },
};

async function take<T>(queue: Array<Queued<T>>, fallback?: T): Promise<T> {
  const next = queue.shift();
  if (next === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error("No fake response queued");
  }
  if (next instanceof Error) throw next;
  return await next;
}

/** Builds a runner object whose methods pull from queues; optional director/tactics are attached per test. */
function runner(options: {
  research?: Array<Queued<ClaimProposal[]>>;
  produces?: Array<Queued<ProducerDraft>>;
  checks?: Array<Queued<FactCheckResult>>;
  localizations?: Array<Queued<LocalizationDraft>>;
  direct?: (input: DirectorInput) => Promise<DirectorProposal>;
  tactics?: (input: TacticsInput) => Promise<ClaimProposal[]>;
} = {}) {
  const queues = {
    research: options.research ?? [[goalClaim]],
    produces: options.produces ?? [goodDraft],
    checks: options.checks ?? [],
    localizations: options.localizations ?? [localization],
  };
  const calls = { research: 0, produce: 0, factCheck: 0, localize: 0, direct: 0, tactics: 0, directInputs: [] as DirectorInput[] };
  const impl: AgentRunner = {
    configured: () => true,
    health: () => ({ mode: "foundry-agents" as const, agents: [] }),
    research: async () => { calls.research += 1; return take(queues.research, []); },
    produce: async () => { calls.produce += 1; return take(queues.produces); },
    factCheck: async () => { calls.factCheck += 1; return take(queues.checks, { verdict: "pass", issues: [] }); },
    localize: async () => { calls.localize += 1; return take(queues.localizations); },
  };
  if (options.direct) {
    const direct = options.direct;
    impl.direct = async (input) => { calls.direct += 1; calls.directInputs.push(input); return direct(input); };
  }
  if (options.tactics) {
    const tactics = options.tactics;
    impl.tactics = async (input) => { calls.tactics += 1; return tactics(input); };
  }
  return { impl, calls };
}

async function waitFor(assertion: () => void, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start >= timeoutMs) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
}

async function runStoryline(agentRunner: AgentRunner, options: Partial<Parameters<typeof createStorylineDesk>[0]> = {}): Promise<Storyline> {
  const desk = createStorylineDesk({ archive: emptyArchive(), runner: agentRunner, ...options });
  const live = view();
  desk.onEvent(live, live.fixture.events[3]);
  await waitFor(() => {
    const status = desk.list(live.matchId)[0]?.status;
    assert.ok(status === "needs_review" || status === "failed", `status ${status}`);
  });
  return desk.list(live.matchId)[0];
}

function workspace(step: StorylineWorkspace["step"]): StorylineWorkspace {
  const live = view();
  const ws = createWorkspace({
    storylineId: "s1",
    matchId: live.matchId,
    trigger: { event: live.fixture.events[3], fixture: live.fixture, matchId: live.matchId, clockSecond: live.clockSecond, score: { home: 1, away: 1 } },
    knownNames: new Set(),
    now: 0,
    maxSteps: 12,
    deadlineMs: 60_000,
  });
  ws.step = step;
  return ws;
}

// ---------------------------------------------------------------- coordinator policy

test("coordinator transition policy enforces the allowed pipeline order", () => {
  const caps = { tactics: true };
  assert.deepEqual(allowedNext(workspace("start"), caps), ["research"]);
  assert.deepEqual(allowedNext(workspace("research"), caps), ["verify"]);
  const verified = workspace("verify");
  assert.deepEqual(allowedNext(verified, caps), ["failed"], "no verified claims => failed");
  verified.claims.verified.push({ id: "c", kind: "live_event", text: { en: "x", es: "x", fr: "x", pt: "x" }, sources: [], status: "verified" });
  assert.deepEqual(allowedNext(verified, caps), ["tactics", "produce"]);
  assert.deepEqual(allowedNext(verified, { tactics: false }), ["produce"]);
  verified.tactics.done = true;
  assert.deepEqual(allowedNext(verified, caps), ["produce"]);
  const produced = workspace("produce");
  assert.deepEqual(allowedNext(produced, caps), ["failed"]);
  produced.currentDraft = goodDraft;
  assert.deepEqual(allowedNext(produced, caps), ["fact_check"]);
  const checked = workspace("fact_check");
  checked.reviews.push({ verdict: "pass", issues: [] });
  assert.deepEqual(allowedNext(checked, caps), ["localize"]);
  checked.reviews.push({ verdict: "revise", issues: ["tighten"] });
  assert.deepEqual(allowedNext(checked, caps), ["revise", "needs_review"]);
  checked.revisions = 1;
  assert.deepEqual(allowedNext(checked, caps), ["needs_review"]);
  assert.deepEqual(allowedNext(workspace("localize"), caps), ["done"]);
});

test("coordinator enforces step budget and deadline and validates director choices", async () => {
  const ws = workspace("fact_check");
  ws.currentDraft = goodDraft;
  ws.reviews.push({ verdict: "revise", issues: ["tighten"] });
  ws.budget.stepsTaken = ws.budget.maxSteps;
  const budget = await decideNext(ws, { now: () => 0, caps: { tactics: false } });
  assert.equal(budget.step, "needs_review");
  assert.equal(budget.recovery, "budget");

  ws.budget.stepsTaken = 1;
  const late = await decideNext(ws, { now: () => 120_000, caps: { tactics: false } });
  assert.equal(late.step, "needs_review");
  assert.match(late.reason, /deadline/u);

  const chosen = await decideNext(ws, { now: () => 0, caps: { tactics: false }, direct: async () => ({ next: "needs_review", reason: "Issues need judgement" }) });
  assert.deepEqual([chosen.step, chosen.decidedBy, chosen.outcome], ["needs_review", "director", "ok"]);

  const illegal = await decideNext(ws, { now: () => 0, caps: { tactics: false }, direct: async () => ({ next: "localize", reason: "skip ahead" }) });
  assert.deepEqual([illegal.step, illegal.decidedBy, illegal.outcome, illegal.recovery], ["revise", "policy", "fallback", "policy_fallback"]);
  assert.match(illegal.reason, /illegal transition/u);

  const broken = await decideNext(ws, { now: () => 0, caps: { tactics: false }, direct: async () => { throw new Error("Timed out invoking liveonair-director"); } });
  assert.deepEqual([broken.step, broken.outcome, broken.errorClass], ["revise", "fallback", "timeout"]);
});

// ---------------------------------------------------------------- recovery primitives

test("errors are classified for recovery routing", () => {
  assert.equal(classifyError(Object.assign(new Error("429"), { status: 429 })), "rate_limit");
  assert.equal(classifyError(new Error("Timed out invoking matchlens-producer")), "timeout");
  assert.equal(classifyError(new SyntaxError("Unexpected token")), "schema_invalid");
  assert.equal(classifyError(new GuardRejectError("Unsupported proper name")), "guard_reject");
  assert.equal(classifyError(Object.assign(new Error("Service Unavailable"), { status: 503 })), "unavailable");
});

test("circuit breaker opens after three consecutive failures and half-opens after the cooldown", () => {
  let clock = 1_000;
  const breaker = new CircuitBreaker({ now: () => clock });
  breaker.recordFailure("producer");
  breaker.recordFailure("producer");
  assert.equal(breaker.status("producer"), "closed");
  breaker.recordSuccess("producer");
  breaker.recordFailure("producer");
  breaker.recordFailure("producer");
  breaker.recordFailure("producer");
  assert.equal(breaker.status("producer"), "open");
  assert.equal(breaker.canCall("producer"), false);
  assert.throws(() => breaker.assertCanCall("producer"), /circuit is open/u);
  assert.equal(breaker.canCall("localizer"), true, "breakers are per agent");
  clock += 60_000;
  assert.equal(breaker.status("producer"), "half_open");
  breaker.recordFailure("producer");
  assert.equal(breaker.status("producer"), "open", "a failed trial re-opens");
  clock += 60_000;
  breaker.recordSuccess("producer");
  assert.equal(breaker.status("producer"), "closed");
});

// ---------------------------------------------------------------- desk with coordinator

test("handoff log is persisted on the storyline for the happy path", async () => {
  const { impl } = runner();
  const storyline = await runStoryline(impl);
  assert.equal(storyline.status, "needs_review");
  assert.deepEqual(storyline.trace.map((step) => step.role), ["researcher", "verifier", "producer", "fact-checker", "localizer"]);
  const handoffs = storyline.handoffs ?? [];
  assert.deepEqual(handoffs.map((handoff) => `${handoff.from}>${handoff.to}`), [
    "desk>researcher",
    "researcher>verifier",
    "verifier>producer",
    "producer>fact-checker",
    "fact-checker>localizer",
    "localizer>human-review",
  ]);
  assert.ok(handoffs.every((handoff) => handoff.outcome === "ok" && !handoff.recovery && handoff.at));
});

test("director chooses among legal transitions and its reason is logged", async () => {
  const { impl, calls } = runner({
    checks: [{ verdict: "revise", issues: ["Needs human judgement"] }],
    direct: async (input) => ({ next: input.allowed.includes("needs_review") ? "needs_review" : input.allowed[0], reason: "Escalate wording question to the producer" }),
  });
  const storyline = await runStoryline(impl);
  assert.equal(storyline.status, "needs_review");
  assert.equal(calls.direct, 1, "director only consulted where policy offers a choice");
  assert.deepEqual(calls.directInputs[0].allowed, ["revise", "needs_review"]);
  assert.equal(calls.directInputs[0].workspace.lastVerdict, "revise");
  assert.equal(calls.produce, 1, "no revision when director escalates");
  const decided = storyline.handoffs?.find((handoff) => handoff.decidedBy === "director");
  assert.equal(decided?.to, "human-review");
  assert.equal(decided?.reason, "Escalate wording question to the producer");
  assert.equal(storyline.trace.at(-1)?.role, "fact-checker");
  assert.equal(storyline.trace.at(-1)?.status, "rejected");
});

test("director failure or illegal proposal falls back to the deterministic default", async () => {
  const failing = runner({ checks: [{ verdict: "revise", issues: ["tighten"] }], produces: [goodDraft, { ...goodDraft, priority: 71 }], direct: async () => { throw Object.assign(new Error("Service Unavailable"), { status: 503 }); } });
  const storyline = await runStoryline(failing.impl);
  assert.equal(storyline.status, "needs_review");
  assert.equal(failing.calls.produce, 2, "default policy revised the draft");
  const fallback = storyline.handoffs?.find((handoff) => handoff.outcome === "fallback");
  assert.equal(fallback?.recovery, "policy_fallback");
  assert.equal(fallback?.errorClass, "unavailable");
  assert.equal(fallback?.to, "producer");
  assert.ok(storyline.trace.some((step) => step.role === "director" && step.status === "rejected"));

  const illegal = runner({ checks: [{ verdict: "revise", issues: ["tighten"] }], produces: [goodDraft, goodDraft], direct: async () => ({ next: "done", reason: "ship it" }) });
  const second = await runStoryline(illegal.impl);
  assert.equal(second.status, "needs_review");
  assert.match(second.handoffs?.find((handoff) => handoff.outcome === "fallback")?.reason ?? "", /illegal transition fact_check → done/u);
});

test("tactics analyst adds only verified claims from engine story cards", async () => {
  const stories: StoryCard[] = [{
    id: "card-pressure",
    kind: "pressure",
    title: "Blue press builds",
    summary: "Blue pressed high before the equaliser",
    whyItMatters: "",
    evidenceIds: ["press-1", "goal-0"],
    metrics: [],
    confidence: "observed",
    importance: 80,
    windowStart: 600,
    windowEnd: 1800,
    teamId: "home",
  }];
  const analyze = (fix: MatchFixture) => ({ fixtureId: fix.id, stories } as unknown as MatchSnapshot);
  const { impl, calls } = runner({
    tactics: async (input) => [
      ...deriveTacticsProposals(input.cards, input),
      { kind: "live_event", params: { eventId: "missing-event" }, sources: [{ type: "event", id: "missing-event" }] },
    ],
  });
  const storyline = await runStoryline(impl, { analyze });
  assert.equal(calls.tactics, 1);
  assert.equal(storyline.status, "needs_review");
  assert.deepEqual(storyline.trace.map((step) => step.role), ["researcher", "verifier", "tactics-analyst", "producer", "fact-checker", "localizer"]);
  const tacticsClaim = storyline.claims.find((claim) => claim.sources.some((source) => source.id === "goal-0"));
  assert.equal(tacticsClaim?.status, "verified");
  assert.match(tacticsClaim?.text.en ?? "", /Cara Lane scored for Red FC/u);
  const rejected = storyline.claims.find((claim) => claim.sources.some((source) => source.id === "missing-event"));
  assert.equal(rejected?.status, "rejected");
  assert.ok(storyline.handoffs?.some((handoff) => handoff.from === "verifier" && handoff.to === "tactics-analyst"));
});

test("tactics analyst failure is skipped as an optional agent", async () => {
  const analyze = (fix: MatchFixture) => ({ fixtureId: fix.id, stories: [{ id: "c", kind: "rhythm", title: "t", summary: "s", whyItMatters: "", evidenceIds: ["goal-0"], metrics: [], confidence: "observed", importance: 50, windowStart: 0, windowEnd: 1800 }] } as unknown as MatchSnapshot);
  const { impl } = runner({ tactics: async () => { throw new SyntaxError("Unexpected token"); } });
  const storyline = await runStoryline(impl, { analyze });
  assert.equal(storyline.status, "needs_review");
  const skipped = storyline.handoffs?.find((handoff) => handoff.recovery === "skip_optional");
  assert.equal(skipped?.from, "tactics-analyst");
  assert.equal(skipped?.errorClass, "schema_invalid");
  assert.ok(storyline.trace.some((step) => step.role === "tactics-analyst" && step.status === "rejected"));
});

test("fact-checker timeout is retried then escalated to human review", async () => {
  const never = new Promise<FactCheckResult>(() => {});
  const { impl, calls } = runner({ checks: [never, never] });
  const storyline = await runStoryline(impl, { agentTimeoutMs: 30 });
  assert.equal(storyline.status, "needs_review");
  assert.equal(calls.factCheck, 2);
  assert.equal(calls.localize, 0);
  const recoveries = (storyline.handoffs ?? []).filter((handoff) => handoff.recovery);
  assert.deepEqual(recoveries.map((handoff) => [handoff.recovery, handoff.errorClass]), [["retry", "timeout"], ["escalate_review", "timeout"]]);
  assert.equal(recoveries[1].to, "human-review");
  assert.equal(storyline.trace.at(-1)?.role, "fact-checker");
  assert.match(storyline.trace.at(-1)?.detail ?? "", /escalated/u);
  assert.equal(storyline.onAirLine.en, goodDraft.onAirLine);
});

test("producer guard rejection is retried with feedback and recorded", async () => {
  const { impl, calls } = runner({ produces: [{ ...goodDraft, onAirLine: "Cara Lane scored for Blue FC." }, goodDraft] });
  const storyline = await runStoryline(impl);
  assert.equal(storyline.status, "needs_review");
  assert.equal(calls.produce, 2);
  const retry = storyline.handoffs?.find((handoff) => handoff.errorClass === "guard_reject");
  assert.equal(retry?.recovery, "retry_with_feedback");
  assert.equal(retry?.from, "producer");
  assert.match(retry?.reason ?? "", /Unsupported proper name/u);
  assert.ok(storyline.trace.some((step) => step.role === "producer" && step.status === "rejected"));
});

test("producer outage fails the storyline with a classified reason", async () => {
  const outage = Object.assign(new Error("Service Unavailable"), { status: 503 });
  const { impl, calls } = runner({ produces: [outage] });
  const storyline = await runStoryline(impl);
  assert.equal(storyline.status, "failed");
  assert.equal(calls.produce, 1, "unavailable is not retried");
  assert.match(storyline.failureReason ?? "", /Producer unavailable \(unavailable\)/u);
  assert.deepEqual([storyline.handoffs?.at(-1)?.from, storyline.handoffs?.at(-1)?.to, storyline.handoffs?.at(-1)?.outcome], ["producer", "desk", "failed"]);
});

test("localizer failure falls back to flagged English-only copy", async () => {
  const { impl } = runner({ localizations: [new Error("Service Unavailable")] });
  const storyline = await runStoryline(impl);
  assert.equal(storyline.status, "needs_review");
  assert.equal(storyline.headline.en, goodDraft.headline);
  assert.equal(storyline.headline.es, "");
  const fallback = storyline.handoffs?.find((handoff) => handoff.recovery === "english_only");
  assert.equal(fallback?.from, "localizer");
  assert.equal(fallback?.outcome, "skipped");
  assert.equal(storyline.trace.at(-1)?.role, "localizer");
  assert.equal(storyline.trace.at(-1)?.status, "rejected");
});

test("open circuit short-circuits the agent across storylines", async () => {
  let clock = Date.now();
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000, now: () => clock });
  breaker.recordFailure("localizer");
  const { impl, calls } = runner();
  const storyline = await runStoryline(impl, { breaker, now: () => clock });
  assert.equal(calls.localize, 0);
  assert.equal(storyline.handoffs?.find((handoff) => handoff.recovery === "english_only")?.errorClass, "unavailable");
  clock += 60_000;
  assert.equal(breaker.status("localizer"), "half_open");
});

test("new Foundry agents are part of the provisioning specs", () => {
  const names = DESK_AGENT_SPECS.map((spec) => spec.name);
  assert.ok(names.includes("liveonair-director"));
  assert.ok(names.includes("liveonair-tactics-analyst"));
});

// ---------------------------------------------------------------- MCP and A2A over the express app

function storyline(id: string, status: Storyline["status"], triggerEventId: string, headline: string): Storyline {
  return {
    id,
    matchId: "m-live",
    triggerEventIds: [triggerEventId],
    triggerMinute: 30,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status,
    priority: 50,
    headline: { en: headline, es: "", fr: "", pt: "" },
    onAirLine: { en: `${headline} on air`, es: "", fr: "", pt: "" },
    overlay: { en: headline, es: "", fr: "", pt: "" },
    claims: [],
    trace: [],
    handoffs: [{ from: "desk", to: "researcher", reason: "trigger", at: "2026-01-01T00:00:00.000Z", outcome: "ok" }],
    version: 1,
  };
}

test("public agent projections show approved and previously-approved retracted storylines only", () => {
  const withdrawn = { ...storyline("s-withdrawn", "retracted", "goal-1", "Withdrawn"), approvedAt: "2026-01-01T00:01:00.000Z" };
  const neverApproved = storyline("s-never", "retracted", "goal-1", "Never approved");
  const all = [storyline("s-approved", "approved", "goal-1", "Approved"), withdrawn, neverApproved, storyline("s-draft", "needs_review", "goal-1", "Draft")];
  assert.deepEqual(visibleStorylines(all, false).map((item) => item.id), ["s-approved", "s-withdrawn"]);
  assert.equal(visibleStorylines(all, true).length, 4);
});

async function withAgentServer(handler: (baseUrl: string, live: { fixture: MatchFixture; goal: MatchEvent }) => Promise<void>, env: Record<string, string> = {}) {
  const liveFixture = structuredClone(getFixture(listFixtures()[0].id));
  const goal = liveFixture.events.find((candidate) => candidate.type === "goal" && !candidate.rescinded)!;
  const liveView = { matchId: "m-live", fixture: liveFixture, clockSecond: liveFixture.durationSeconds };
  const storylines = [
    storyline("s-approved", "approved", goal.id, "Approved headline"),
    storyline("s-draft", "needs_review", goal.id, "Draft headline"),
  ];
  const platform = {
    live: {
      status: () => ({ state: "finished", transport: "local", transportConfigured: false, clockSecond: liveFixture.durationSeconds, speed: 1, eventsReceived: liveFixture.events.length, duplicatesIgnored: 0, stress: false }),
      current: () => liveView,
      addListener: () => () => {},
    },
    desk: {
      list: () => structuredClone(storylines),
      facts: () => [],
      health: () => ({ mode: "unconfigured", agents: [], retrieval: "unconfigured" }),
      subscribe: () => () => {},
    },
    close: async () => undefined,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const narrator = { health: () => ({ configured: false, deployment: "", authentication: "unconfigured" }), narrate: async () => { throw new Error("unused"); } };
  try {
    const app = createApp({ narrator: narrator as never, platform: platform as never, staticDir, version: "test-version", logger: () => {} });
    const server = http.createServer(app);
    await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      await handler(baseUrl, { fixture: liveFixture, goal });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveServer) => server.close(() => resolveServer()));
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function toolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

test("MCP endpoint exposes the read-only tool contract", async () => {
  await withAgentServer(async (baseUrl, live) => {
    const client = new Client({ name: "matchlens-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        "get_chance_insights", "get_event", "get_live_snapshot", "get_live_status", "get_player_stats", "list_storylines", "search_archive", "verify_claim",
      ]);
      assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));

      const status = toolJson(await client.callTool({ name: "get_live_status", arguments: {} }));
      assert.equal(status.state, "finished");

      const snapshot = toolJson(await client.callTool({ name: "get_live_snapshot", arguments: { persona: "casual", language: "es", period: "first" } }));
      assert.equal(snapshot.matchId, "m-live");
      assert.ok(Array.isArray(snapshot.stories));
      assert.equal(snapshot.synthetic, true);

      const fetched = toolJson(await client.callTool({ name: "get_event", arguments: { eventId: live.goal.id } }));
      assert.equal((fetched.event as MatchEvent).id, live.goal.id);
      const missing = await client.callTool({ name: "get_event", arguments: { eventId: "nope" } });
      assert.equal(missing.isError, true);

      const players = toolJson(await client.callTool({ name: "get_player_stats", arguments: { playerId: live.goal.playerId } }));
      const stats = (players.players as Array<Record<string, unknown>>)[0];
      assert.ok((stats.goals as number) >= 1);
      assert.equal("touches" in stats, false);

      const search = toolJson(await client.callTool({ name: "search_archive", arguments: { query: "final" } }));
      assert.equal(search.mode, "local-keyword");
      assert.ok(Array.isArray(search.results));

      const listed = toolJson(await client.callTool({ name: "list_storylines", arguments: { includeDrafts: true } }));
      assert.equal(listed.scope, "approved", "drafts need an authenticated studio caller");
      assert.deepEqual((listed.storylines as Array<{ id: string }>).map((item) => item.id), ["s-approved"]);

      const verified = toolJson(await client.callTool({ name: "verify_claim", arguments: { kind: "live_event", params: { eventId: live.goal.id }, sources: [{ type: "event", id: live.goal.id }] } }));
      assert.equal(verified.ok, true);
      const rejected = toolJson(await client.callTool({ name: "verify_claim", arguments: { kind: "live_event", params: { eventId: "invented" }, sources: [{ type: "event", id: "invented" }] } }));
      assert.equal(rejected.ok, false);
    } finally {
      await client.close();
    }

    const get = await fetch(`${baseUrl}/mcp`);
    assert.equal(get.status, 405);
  });
});

test("MCP endpoint requires the bearer token when MCP_TOKEN is set and then allows studio scope", async () => {
  await withAgentServer(async (baseUrl) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const denied = await fetch(`${baseUrl}/mcp`, { method: "POST", headers, body });
    assert.equal(denied.status, 401);
    const wrong = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body });
    assert.equal(wrong.status, 401);

    const raw = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer secret-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_storylines", arguments: { includeDrafts: true } } }),
    });
    assert.equal(raw.status, 200);
    const payload = await raw.json() as { result: { content: Array<{ text: string }> } };
    const listed = JSON.parse(payload.result.content[0].text) as { scope: string; storylines: Array<{ id: string; handoffs?: unknown[] }> };
    assert.equal(listed.scope, "studio");
    assert.deepEqual(listed.storylines.map((item) => item.id), ["s-approved", "s-draft"]);
    assert.ok(Array.isArray(listed.storylines[0].handoffs));
  }, { MCP_TOKEN: "secret-token" });
});

test("A2A agent card and message/send return approved storylines for an event", async () => {
  await withAgentServer(async (baseUrl, live) => {
    const card = await fetch(`${baseUrl}/.well-known/agent-card.json`).then((response) => response.json()) as Record<string, unknown>;
    for (const field of ["name", "description", "url", "version", "capabilities", "skills", "defaultInputModes", "defaultOutputModes", "protocolVersion"]) {
      assert.ok(field in card, `agent card has ${field}`);
    }
    assert.equal(card.url, `${baseUrl}/a2a`);
    assert.equal(card.version, "test-version");
    assert.equal((card.skills as unknown[]).length, 1);

    const rpc = async (payload: unknown, headers: Record<string, string> = {}) => fetch(`${baseUrl}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    }).then((response) => response.json()) as Promise<Record<string, any>>;

    const sent = await rpc({
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: { message: { kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: `Give me the storyline for event ${live.goal.id}` }] } },
    });
    assert.equal(sent.id, "req-1");
    const task = sent.result;
    assert.equal(task.kind, "task");
    assert.equal(task.status.state, "completed");
    assert.equal(task.metadata.humanApprovalRequired, true);
    const data = task.artifacts[0].parts[0].data;
    assert.equal(data.eventId, live.goal.id);
    assert.equal(data.scope, "approved");
    assert.deepEqual(data.storylines.map((item: { id: string }) => item.id), ["s-approved"]);
    assert.ok(data.storylines.every((item: { approved: boolean }) => item.approved));

    const fetched = await rpc({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: task.id } });
    assert.equal(fetched.result.id, task.id);
    const missing = await rpc({ jsonrpc: "2.0", id: 3, method: "tasks/get", params: { id: "nope" } });
    assert.equal(missing.error.code, -32001);

    const dataPart = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "message/send",
      params: { message: { kind: "message", role: "user", messageId: "m2", parts: [{ kind: "data", data: { eventId: live.goal.id } }] } },
    }, { authorization: "Bearer a2a-secret" });
    assert.equal(dataPart.result.artifacts[0].parts[0].data.scope, "studio");
    assert.equal(dataPart.result.artifacts[0].parts[0].data.storylines.length, 2);

    assert.equal((await rpc({ jsonrpc: "2.0", id: 5, method: "message/stream", params: {} })).error.code, -32601);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 6, method: "message/send", params: { message: { parts: [] } } })).error.code, -32602);
    assert.equal((await rpc({ hello: "world" })).error.code, -32600);
  }, { A2A_TOKEN: "a2a-secret" });
});
