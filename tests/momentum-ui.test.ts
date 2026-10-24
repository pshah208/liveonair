import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { generateMatch } from "../server/matchlab/generator.js";
import { computeMomentum, type ControlChaosWindow, type MomentumPoint } from "../shared/momentum.js";
import type { MatchEvent } from "../shared/types.js";
import {
  CONTROL_INSUFFICIENT_MESSAGE,
  INSUFFICIENT_COVERAGE_MESSAGE,
  latestControlWindow,
  leadingSpells,
  MOMENTUM_LABEL,
  momentumGeometry,
  momentumSummary,
  momentumUpTo,
  pressureChangeText,
  resolveMomentumPalette,
  SAFE_AWAY,
  SAFE_HOME,
  SIMULATED_ENGAGEMENT_LABEL,
  simulatedEngagement,
  SPONSOR_LABEL,
} from "../src/momentumView.js";
import { CONTROL_AGENT, MOMENTUM_AGENT, whyItMattersParts, whyItMattersText } from "../src/WhyItMatters.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const match = generateMatch({ scenario: "comeback", seed: 2025 });

function ev(partial: Partial<MatchEvent> & Pick<MatchEvent, "id" | "type" | "teamId">): MatchEvent {
  return { revision: 1, minute: 0, second: 0, playerId: "p", outcome: "complete", x: 50, y: 50, ...partial };
}

function point(minute: number, netThreat: number): MomentumPoint {
  return { minute, period: minute < 45 ? 1 : 2, homeThreat: Math.max(0, netThreat), awayThreat: Math.max(0, -netThreat), netThreat };
}

function windowOf(partial: Partial<ControlChaosWindow>): ControlChaosWindow {
  return { startMinute: 63, endMinute: 68, period: 2, completedPassShare: 0.7, possessionChanges: 9, shots: 3, matchedPressureEvents: 4, pressureDeltaFromPrevious: 1, label: "chaotic", insufficientCoverage: false, ...partial };
}

// Every number in a why-it-matters line must carry its unit or be a minute mark.
const UNEXPLAINED_NUMBER = /\d+(?!\d|'|%| shots?\b| goals?\b| possession changes?\b| pressing actions?\b)/;

// ---- momentum shaping ---------------------------------------------------------

test("momentumUpTo trims to the live minute and drops future markers", () => {
  const live = momentumUpTo(match.events, 30);
  assert.equal(live.points.at(-1)?.minute, 30);
  assert.ok(live.points.every((p) => p.minute <= 30));
  assert.ok(live.goals.every((g) => g.minute <= 30));
  assert.ok(live.substitutions.every((s) => s.minute <= 30));
  assert.equal(live.insufficientCoverage, false, "dense synthetic feed has coverage after half an hour");
  assert.deepEqual(momentumUpTo(match.events, 30), live, "deterministic");
});

test("momentumUpTo re-smooths at the live edge without the empty future", () => {
  const live = momentumUpTo(match.events, 30);
  const last = live.points.at(-1)!;
  const prev = live.points.at(-2)!;
  const expected = ((prev.homeThreat - prev.awayThreat) + (last.homeThreat - last.awayThreat)) / 2;
  assert.ok(Math.abs(last.netThreat - expected) < 0.002);
});

test("full-match momentum matches the data layer away from the edges", () => {
  const full = momentumUpTo(match.events, null);
  const layer = computeMomentum(match.events);
  assert.equal(full.insufficientCoverage, layer.insufficientCoverage);
  for (const minute of [10, 44, 60]) assert.ok(Math.abs(full.points[minute]!.netThreat - layer.points[minute]!.netThreat) < 0.002);
  assert.deepEqual(full.goals, layer.goals);
});

test("coverage is judged over elapsed minutes: kickoff, sparse video-like feeds and empty feeds are insufficient", () => {
  assert.equal(momentumUpTo(match.events, 1).insufficientCoverage, true, "first minutes are too early");
  const sparse = Array.from({ length: 12 }, (_, i) => ev({ id: `s${i}`, type: "pass", teamId: i % 2 ? "home" : "away", minute: i * 2, endX: 70, endY: 50 }));
  assert.equal(momentumUpTo(sparse, 24).insufficientCoverage, true);
  assert.equal(momentumUpTo([], 10).insufficientCoverage, true);
  assert.equal(momentumUpTo([], null).points.length, 0);
});

// ---- palette ------------------------------------------------------------------------

test("palette keeps distinct team colours and falls back to blue/orange for red/green or near-identical pairs", () => {
  assert.deepEqual(resolveMomentumPalette(), { home: "var(--team-home)", away: "var(--team-away)", fallback: false });
  assert.deepEqual(resolveMomentumPalette("#1d4ed8", "#facc15"), { home: "#1d4ed8", away: "#facc15", fallback: false });
  assert.deepEqual(resolveMomentumPalette("#d7191c", "#1a9641"), { home: SAFE_HOME, away: SAFE_AWAY, fallback: true }, "red vs green");
  assert.deepEqual(resolveMomentumPalette("#2e7d32", "#c62828"), { home: SAFE_HOME, away: SAFE_AWAY, fallback: true }, "green vs red");
  assert.equal(resolveMomentumPalette("#1e3a8a", "#1d4ed8").fallback, true, "two blues are too close");
  assert.equal(resolveMomentumPalette("#fff", "#fafafa").fallback, true, "two whites");
  assert.equal(resolveMomentumPalette("claret", "#ffffff").fallback, true, "unparseable colour");
});

// ---- geometry -------------------------------------------------------------------------

test("geometry puts home above and away below the zero line, split at the crossing", () => {
  const geo = momentumGeometry([point(0, 0.2), point(1, -0.2), point(2, 0.1)], 400, 120);
  const ys = (d: string) => [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => Number(m[2]));
  assert.ok(ys(geo.homeArea).every((y) => y <= geo.zeroY + 1e-9));
  assert.ok(ys(geo.awayArea).every((y) => y >= geo.zeroY - 1e-9));
  assert.match(geo.line, /L[\d.]+,60\b/, "crossing vertex sits on the zero line");
  assert.equal(geo.domainMax, 90);
  assert.equal(geo.x(0), 4);
  assert.equal(geo.x(90), 396);
  assert.deepEqual(momentumGeometry([], 400, 120).homeArea, "");
});

test("leading spells need two clear minutes in a row", () => {
  const points = [point(0, 0.3), point(1, 0.3), point(2, 0), point(3, -0.3), point(4, 0), point(5, -0.3), point(6, -0.3), point(7, -0.3)];
  assert.deepEqual(leadingSpells(points), [
    { teamId: "home", startMinute: 0, endMinute: 1 },
    { teamId: "away", startMinute: 5, endMinute: 7 },
  ]);
});

test("aria summary names the label, both teams and goals", () => {
  const summary = momentumSummary(momentumUpTo(match.events, null), match.home.name, match.away.name);
  assert.ok(summary.startsWith(MOMENTUM_LABEL));
  assert.ok(summary.includes(match.home.name) && summary.includes(match.away.name));
  assert.match(summary, /Goals: /);
  assert.match(momentumSummary(momentumUpTo([], 5), "A", "B"), /not enough match events/);
});

// ---- control vs chaos --------------------------------------------------------------------

test("latestControlWindow returns the latest completed five-minute window", () => {
  const live = latestControlWindow(match.events, 63);
  assert.equal(live.current?.startMinute, 55);
  assert.equal(live.current?.endMinute, 60);
  assert.equal(live.previous?.endMinute, 55);
  assert.equal(latestControlWindow(match.events, 3).current, null, "first window still open");
  const full = latestControlWindow(match.events, null);
  assert.equal(full.current?.endMinute, 90);
  assert.deepEqual(latestControlWindow([], 20), { current: null, previous: null });
});

test("pressure change wording", () => {
  assert.equal(pressureChangeText(null), "No previous window to compare");
  assert.equal(pressureChangeText(0), "Same number of pressing actions as the previous five minutes");
  assert.equal(pressureChangeText(1), "1 pressing action more than the previous five minutes");
  assert.equal(pressureChangeText(-4), "4 pressing actions fewer than the previous five minutes");
});

// ---- why it matters ---------------------------------------------------------------------------

test("whyItMattersText for a chaotic window names the agent, the evidence and the brief's terms", () => {
  const text = whyItMattersText({ kind: "control", window: windowOf({}) })!;
  assert.ok(text.includes(CONTROL_AGENT));
  assert.ok(text.includes("3 shots and 9 possession changes in 63'–68'"));
  assert.match(text, /^Chaotic passage: .*game rhythm/);
  assert.doesNotMatch(text, UNEXPLAINED_NUMBER);
});

test("whyItMattersText covers controlled and mixed passages and pressing swings", () => {
  const controlled = whyItMattersParts({ kind: "control", window: windowOf({ label: "controlled", shots: 1, possessionChanges: 5, completedPassShare: 0.81, pressureDeltaFromPrevious: 4 }) })!;
  assert.match(controlled.sentence, /^Controlled passage/);
  assert.match(controlled.sentence, /Pressing is rising\.$/);
  assert.equal(controlled.evidence, "81% of passes completed and 5 possession changes in 63'–68'");
  const mixed = whyItMattersText({ kind: "control", window: windowOf({ label: "mixed", shots: 1, possessionChanges: 1, completedPassShare: null, pressureDeltaFromPrevious: -3 }) })!;
  assert.match(mixed, /^Mixed passage: neither control nor chaos/);
  assert.match(mixed, /Pressing has eased/);
  assert.ok(mixed.includes("1 shot and 1 possession change in 63'–68'"));
  for (const text of [controlled.sentence + controlled.evidence, mixed]) assert.doesNotMatch(text, UNEXPLAINED_NUMBER);
});

test("whyItMattersText is null when coverage is too thin", () => {
  assert.equal(whyItMattersText({ kind: "control", window: null }), null);
  assert.equal(whyItMattersText({ kind: "control", window: windowOf({ insufficientCoverage: true }) }), null);
  assert.equal(whyItMattersText({ kind: "momentum", series: momentumUpTo([], 10), events: [], homeName: "A", awayName: "B" }), null);
});

test("momentum why-it-matters is deterministic, plain and explains every number at several minutes", () => {
  for (const minute of [12, 30, 63, 89]) {
    const series = momentumUpTo(match.events, minute);
    const input = { kind: "momentum" as const, series, events: match.events, homeName: match.home.name, awayName: match.away.name };
    const text = whyItMattersText(input)!;
    assert.equal(whyItMattersText(input), text);
    assert.ok(text.includes(MOMENTUM_AGENT), text);
    assert.match(text, /Evidence: .* in \d+'–\d+'$/, text);
    assert.doesNotMatch(text.replace(match.home.name, "").replace(match.away.name, ""), UNEXPLAINED_NUMBER, text);
  }
});

test("a one-sided spell is credited to the dominant side with its shots", () => {
  const events: MatchEvent[] = [];
  for (let minute = 0; minute < 12; minute += 1) {
    for (let k = 0; k < 4; k += 1) events.push(ev({ id: `p${minute}-${k}`, type: "pass", teamId: "away", minute, second: k * 10, x: 40, y: 50, endX: 85, endY: 50 }));
    events.push(ev({ id: `s${minute}`, type: "shot", teamId: "away", minute, second: 50, x: 88, y: 50, outcome: "miss" }));
  }
  const series = momentumUpTo(events, 11);
  const parts = whyItMattersParts({ kind: "momentum", series, events, homeName: "Eastford", awayName: "Vale" })!;
  assert.match(parts.sentence, /^Vale are on top/);
  assert.equal(parts.evidence, "5 shots for Vale and 0 shots for Eastford in 7'–11'");
});

test("an even recent spell reads as balanced even after an earlier one-sided peak", () => {
  const events: MatchEvent[] = [];
  for (let minute = 0; minute < 16; minute += 1) {
    const early = minute < 6;
    for (let k = 0; k < 4; k += 1) {
      const teamId = early ? "away" : k % 2 ? "home" : "away";
      events.push(ev({ id: `p${minute}-${k}`, type: "pass", teamId, minute, second: k * 10, x: 40, y: 50, endX: 80, endY: 50 }));
    }
  }
  const parts = whyItMattersParts({ kind: "momentum", series: momentumUpTo(events, 15), events, homeName: "Eastford", awayName: "Vale" })!;
  assert.match(parts.sentence, /^Neither side is on top right now/);
  assert.match(parts.sentence, /last clear spell belonged to Vale/);
  assert.equal(parts.evidence, "0 shots for Eastford and 0 shots for Vale in 11'–15'");
});

// ---- simulated engagement -------------------------------------------------------------------------

test("simulated engagement is deterministic, grows with the clock and only lists moments that have happened", () => {
  const goals = [{ eventId: "g1", minute: 20, teamId: "home" as const, period: 1 as const }, { eventId: "g2", minute: 70, teamId: "away" as const, period: 2 as const }];
  const name = (t: "home" | "away") => (t === "home" ? "Eastford" : "Vale");
  const a = simulatedEngagement("match-1", 50, goals, name);
  assert.deepEqual(simulatedEngagement("match-1", 50, goals, name), a);
  assert.ok(simulatedEngagement("match-1", 80, goals, name).optIns > a.optIns);
  assert.deepEqual(a.dropOffs.map((d) => d.moment), ["After the Eastford goal", "Half-time break"]);
  assert.ok(a.avgMinutesEngaged <= 50);
  assert.equal(simulatedEngagement("match-1", 0, [], name).avgMinutesEngaged, 0);
  assert.equal(SIMULATED_ENGAGEMENT_LABEL, "Simulated — no real users");
  assert.equal(SPONSOR_LABEL, "Momentum segment presented by Northwind Sports");
});

// ---- source-level UI checks (no DOM harness) -------------------------------------------------------

test("MomentumChart keeps the exact props contract Fan View relies on", () => {
  const chart = read("src/MomentumChart.tsx");
  assert.match(chart, /export interface MomentumChartProps \{\s*series: MomentumSeries;\s*homeName: string;\s*awayName: string;\s*homeColor\?: string;\s*awayColor\?: string;\s*compact\?: boolean;\s*explanation\?: string;\s*\}/);
  assert.match(chart, /export function MomentumChart\(\{ series, homeName, awayName, homeColor, awayColor, compact = false, explanation \}: MomentumChartProps\)/);
});

test("MomentumChart is labelled, accessible and free of third-party branding", () => {
  const chart = read("src/MomentumChart.tsx");
  assert.equal(MOMENTUM_LABEL, "Illustrative attacking threat (synthetic)");
  assert.match(chart, /\{MOMENTUM_LABEL\}/);
  assert.match(chart, /role="img" aria-label=\{momentumSummary\(/);
  assert.match(chart, /<table className="sr-only">/);
  assert.match(chart, /\{INSUFFICIENT_COVERAGE_MESSAGE\}/);
  assert.match(INSUFFICIENT_COVERAGE_MESSAGE, /^Not enough match events yet/);
  assert.match(chart, /momentum__halftime/);
  assert.match(chart, /series\.goals\.map/);
  assert.match(chart, /series\.substitutions\.map/);
  for (const banned of [/crest/i, /logo/i, /Opta/, /Premier League/, /<img\b/]) assert.doesNotMatch(chart, banned);
  const css = read("src/momentum.css");
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{[^}]*transition/);
});

test("Control vs chaos card uses the brief's terms and guards coverage", () => {
  const card = read("src/ControlChaosCard.tsx");
  assert.match(card, /Control vs chaos/);
  assert.match(card, /game rhythm/);
  assert.match(card, /\{CONTROL_INSUFFICIENT_MESSAGE\}/);
  assert.match(CONTROL_INSUFFICIENT_MESSAGE, /control vs chaos/);
  for (const label of ["Completed passes", "Possession changes", "Shots", "Pressing:"]) assert.ok(card.includes(label), label);
});

test("Studio Desk wires the momentum chart, control vs chaos, why-it-matters and the simulated engagement panel", () => {
  const studio = read("src/StudioPage.tsx");
  assert.match(studio, /<MomentumChart series=\{momentum\}[^>]*explanation=\{momentumWhy \?\? undefined\}/);
  assert.match(studio, /<ControlChaosCard window=\{control\.current\} explanation=\{controlWhy \?\? undefined\}/);
  assert.match(studio, /title="Second-screen engagement \(simulated\)"/);
  assert.match(studio, /Momentum segment presented by <strong>\{SPONSOR_NAME\}<\/strong>/);
  assert.match(studio, /momentumUpTo\(fixture\.events, rhythmMinute\)/);
  assert.match(read("src/SecondScreenPanel.tsx"), /\{SIMULATED_ENGAGEMENT_LABEL\}/);
  assert.doesNotMatch(read("src/FanPage.tsx"), /SecondScreenEngagement|simulatedEngagement/, "engagement stays on Studio Desk");
});
