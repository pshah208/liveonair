import type { ControlChaosWindow, MomentumSeries } from "../shared/momentum.js";
import type { MatchEvent, TeamId } from "../shared/types.js";
import { leadingSpells } from "./momentumView.js";

// Deterministic "why it matters" lines. No LLM: every sentence is built from the event data, and every number in
// the output carries its unit (shots, possession changes, % of passes, or a minute mark like 63').

export const MOMENTUM_AGENT = "Match analyst";
export const CONTROL_AGENT = "Tactics analyst";
/** One side "on top" when it holds at least this share lead of the last five minutes' threat (e.g. 68% vs 32%). */
const LEAN_SHARE = 0.35;
/** Below this much combined illustrative threat in five minutes, nobody is "on top". */
const LEAN_MIN_THREAT = 0.1;

export interface WhyItMattersParts {
  sentence: string;
  agent: string;
  evidence: string;
}

export type WhyItMattersInput =
  | { kind: "momentum"; series: MomentumSeries; events: MatchEvent[]; homeName: string; awayName: string }
  | { kind: "control"; window: ControlChaosWindow | null };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const span = (start: number, end: number) => `${start}'–${end}'`;

function shotsFor(events: MatchEvent[], teamId: TeamId, startMinute: number, endMinute: number): number {
  const latest = new Map<string, MatchEvent>();
  for (const event of events) {
    const previous = latest.get(event.id);
    if (!previous || event.revision >= previous.revision) latest.set(event.id, event);
  }
  return [...latest.values()].filter((event) => !event.rescinded && event.type === "shot" && event.teamId === teamId && event.minute >= startMinute && event.minute <= endMinute).length;
}

function momentumParts(input: Extract<WhyItMattersInput, { kind: "momentum" }>): WhyItMattersParts | null {
  const { series, events, homeName, awayName } = input;
  if (series.insufficientCoverage || series.points.length === 0) return null;
  const name = (teamId: TeamId) => (teamId === "home" ? homeName : awayName);
  const lastMinute = series.points[series.points.length - 1]!.minute;
  // "Who is on top now" = share of the raw threat over the last five minutes, not one peak earlier in the match.
  const start = Math.max(0, lastMinute - 4);
  const recent = series.points.filter((point) => point.minute >= start);
  const homeThreat = recent.reduce((sum, point) => sum + point.homeThreat, 0);
  const awayThreat = recent.reduce((sum, point) => sum + point.awayThreat, 0);
  const total = homeThreat + awayThreat;
  const lean = total > 0 ? (homeThreat - awayThreat) / total : 0;
  const shots = { home: shotsFor(events, "home", start, lastMinute), away: shotsFor(events, "away", start, lastMinute) };
  const shotLine = (first: TeamId) => {
    const second: TeamId = first === "home" ? "away" : "home";
    return `${plural(shots[first], "shot", "shots")} for ${name(first)} and ${plural(shots[second], "shot", "shots")} for ${name(second)} in ${span(start, lastMinute)}`;
  };
  if (total >= LEAN_MIN_THREAT && Math.abs(lean) >= LEAN_SHARE) {
    const teamId: TeamId = lean > 0 ? "home" : "away";
    const goals = series.goals.filter((goal) => goal.teamId === teamId && goal.minute >= start);
    const payoff = goals.length ? `, and it has paid off with a goal in ${goals[goals.length - 1]!.minute}'` : "";
    return {
      sentence: `${name(teamId)} are on top: they have carried most of the attacking threat over the last few minutes${payoff}.`,
      agent: MOMENTUM_AGENT,
      evidence: shotLine(teamId),
    };
  }
  const spells = leadingSpells(series.points.filter((point) => point.minute < start));
  const latest = spells[spells.length - 1];
  const swing = latest ? ` The last clear spell belonged to ${name(latest.teamId)}, up to ${latest.endMinute}'.` : "";
  return {
    sentence: `Neither side is on top right now, so the game is evenly balanced.${swing}`,
    agent: MOMENTUM_AGENT,
    evidence: shotLine("home"),
  };
}

function controlParts(window: ControlChaosWindow | null): WhyItMattersParts | null {
  if (!window || window.insufficientCoverage) return null;
  const when = span(window.startMinute, window.endMinute);
  const changes = plural(window.possessionChanges, "possession change", "possession changes");
  const shots = plural(window.shots, "shot", "shots");
  const pressing = window.pressureDeltaFromPrevious === null || Math.abs(window.pressureDeltaFromPrevious) < 3
    ? ""
    : window.pressureDeltaFromPrevious > 0 ? " Pressing is rising." : " Pressing has eased.";
  const share = window.completedPassShare === null ? null : `${Math.round(window.completedPassShare * 100)}% of passes completed`;
  if (window.label === "chaotic") {
    return {
      sentence: `Chaotic passage: the ball keeps changing hands, so the game rhythm is stretched and chances can come at either end.${pressing}`,
      agent: CONTROL_AGENT,
      evidence: `${shots} and ${changes} in ${when}`,
    };
  }
  if (window.label === "controlled") {
    return {
      sentence: `Controlled passage: one side is keeping the ball and setting a calmer game rhythm.${pressing}`,
      agent: CONTROL_AGENT,
      evidence: `${share ?? shots} and ${changes} in ${when}`,
    };
  }
  return {
    sentence: `Mixed passage: neither control nor chaos, so the game rhythm could tip either way.${pressing}`,
    agent: CONTROL_AGENT,
    evidence: `${share ? `${share}, ` : ""}${shots} and ${changes} in ${when}`,
  };
}

export function whyItMattersParts(input: WhyItMattersInput): WhyItMattersParts | null {
  return input.kind === "momentum" ? momentumParts(input) : controlParts(input.window);
}

/** One-line chip text: the explanation, the authoring agent and the evidence. `null` when coverage is too thin. */
export function whyItMattersText(input: WhyItMattersInput): string | null {
  const parts = whyItMattersParts(input);
  return parts ? `${parts.sentence} — ${parts.agent} · Evidence: ${parts.evidence}` : null;
}

export function WhyItMatters({ text }: { text: string }) {
  return (
    <p className="why-chip">
      <span className="why-chip__label">Why it matters</span>
      <span className="why-chip__text">{text}</span>
    </p>
  );
}
