import { AIProjectClient } from "@azure/ai-projects";
import { z } from "zod";

import { analysePlayers, IMPACT_RATING_BASELINE, IMPACT_RATING_FORMULA, IMPACT_RATING_MAX, IMPACT_RATING_MIN, IMPACT_RATING_SCALE, IMPACT_RATING_SPAN, IMPACT_WEIGHTS, type PlayerAnalysis } from "../../shared/playerStats.js";
import { PERIOD_LABEL, periodScope } from "../../shared/periods.js";
import type { Language, MatchFixture, MatchPeriod } from "../../shared/types.js";
import { getAzureCredential } from "../azure/credential.js";
import { PLAYER_ANALYST_AGENT_NAME, playerAnalystAgentSpec } from "../desk/agents/player-analyst.js";
import { invokeAgentJson } from "../desk/runner.js";
import { groundingProblems } from "../spokenGuard.js";
import { HttpError } from "../validation.js";

/**
 * Scouting notes for one player, written by the Foundry "player analyst" agent from event-derived
 * statistics. Every number and name in the note is checked against those statistics; anything else
 * falls back to a rules-based note so the pundit always gets a grounded answer.
 */

export type PlayerNote = {
  playerId: string;
  headline: string;
  summary: string;
  strengths: string[];
  concerns: string[];
  source: "foundry" | "rules";
  agent?: string;
  problem?: string;
  /** Scope and watermark the figures were computed for, so clients can discard stale replies. */
  period?: MatchPeriod;
  asOfSecond?: number;
};

export interface PlayerAnalyst {
  readonly configured: boolean;
  write(fixture: MatchFixture, playerId: string, language: Language, clockSecond: number, period?: MatchPeriod): Promise<PlayerNote>;
}

type Invoke = (input: string) => Promise<unknown>;

const LANGUAGE_NAME: Record<Language, string> = { en: "British English", es: "Spanish (Spain)", fr: "French (France)", pt: "Brazilian Portuguese" };
// Spelled out so the scope adds no digits the grounding guard would then accept.
const PERIOD_SCOPE: Record<MatchPeriod, string> = { full: "full match so far", first: "first half only", second: "second half only" };
const noteSchema = z.object({
  headline: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(900),
  strengths: z.array(z.string().trim().min(1).max(200)).max(3),
  concerns: z.array(z.string().trim().min(1).max(200)).max(3),
}).strict();
const CACHE_MAX = 64;

function figures(player: PlayerAnalysis) {
  return {
    name: player.player.name,
    shirtNumber: player.player.number || undefined,
    position: player.player.position || undefined,
    impactRating: player.impact.rating,
    impactBreakdown: Object.fromEntries(player.impact.components.map((component) => [component.label, component.value])),
    involvements: player.involvements,
    shareOfTeamActionsPercent: player.involvementShare,
    goals: player.goals,
    assists: player.assists,
    shots: player.shots,
    shotsOnTarget: player.shotsOnTarget,
    xg: player.xg,
    xa: player.xa,
    keyPasses: player.keyPasses,
    passes: player.passes,
    passesCompleted: player.passesCompleted,
    passAccuracyPercent: player.passAccuracy,
    progressivePasses: player.progressivePasses,
    touchesInOppositionBox: player.touchesInBox,
    tackles: player.tackles,
    tacklesWon: player.tacklesWon,
    tackleSuccessPercent: player.tackles ? Math.round((player.tacklesWon / player.tackles) * 100) : undefined,
    shotsOnTargetPercent: player.shots ? Math.round((player.shotsOnTarget / player.shots) * 100) : undefined,
    goalConversionPercent: player.shots ? Math.round((player.goals / player.shots) * 100) : undefined,
    pressures: player.pressures,
    saves: player.saves,
    possessionLost: player.possessionLost,
    foulsCommitted: player.fouls,
    yellowCards: player.yellowCards,
    redCards: player.redCards,
  };
}

/** The JSON the agent sees; the grounding guard checks the note against exactly this text. */
export function analystInput(fixture: MatchFixture, playerId: string, language: Language, clockSecond: number, period: MatchPeriod = "full") {
  const scope = periodScope(fixture, period, clockSecond);
  if (!scope.available) {
    throw new HttpError(409, scope.reason === "not_started" ? `The ${PERIOD_LABEL[period]} has not started yet` : "Half-by-half figures are unavailable for this match");
  }
  const whole = analysePlayers(fixture, clockSecond);
  const all = period === "full" ? whole : analysePlayers(fixture, clockSecond, period);
  const target = all.find((entry) => entry.player.id === playerId);
  if (!target) throw new HttpError(404, "Player not found in this match");
  const teammates = all.filter((entry) => entry.teamId === target.teamId && entry.involvements > 0)
    .sort((a, b) => b.impact.rating - a.impact.rating);
  const goals = { home: 0, away: 0 };
  for (const entry of whole) goals[entry.teamId] += entry.goals;
  const periodGoals = { home: 0, away: 0 };
  for (const entry of all) periodGoals[entry.teamId] += entry.goals;
  return {
    target,
    payload: {
      language: LANGUAGE_NAME[language],
      ...(period === "full" ? {} : { period: PERIOD_SCOPE[period] }),
      match: {
        home: fixture.home.name,
        away: fixture.away.name,
        score: `${goals.home}-${goals.away}`,
        ...(period === "full" ? {} : { goalsInPeriod: `${periodGoals.home}-${periodGoals.away}` }),
        minutesPlayedInMatch: Math.floor(clockSecond / 60),
        team: target.teamId === "home" ? fixture.home.name : fixture.away.name,
      },
      player: figures(target),
      teamRankByImpact: teammates.findIndex((entry) => entry.player.id === playerId) + 1 || undefined,
      teamPlayersWithActions: teammates.length,
      teamTopPerformer: teammates[0] && teammates[0].player.id !== playerId ? { name: teammates[0].player.name, impactRating: teammates[0].impact.rating } : undefined,
      impactModel: `${IMPACT_RATING_FORMULA} Illustrative, from logged events only.`,
    },
  };
}

/** Rules-based fallback: plain statements built only from the computed figures. */
export function rulesNote(player: PlayerAnalysis): PlayerNote {
  const strengths: string[] = [];
  const concerns: string[] = [];
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (player.goals > 0) strengths.push(`${plural(player.goals, "goal")} from ${plural(player.shots, "shot")}`);
  if (player.assists > 0 || player.keyPasses > 0) strengths.push(`${plural(player.keyPasses, "chance")} created, ${plural(player.assists, "assist")}`);
  if (player.passAccuracy !== null && player.passes >= 5 && player.passAccuracy >= 80) strengths.push(`${player.passAccuracy}% passing from ${player.passes} passes`);
  if (player.tacklesWon > 0) strengths.push(`${player.tacklesWon} of ${player.tackles} tackles won`);
  if (player.saves > 0) strengths.push(plural(player.saves, "save"));
  if (player.passAccuracy !== null && player.passes >= 5 && player.passAccuracy < 65) concerns.push(`${player.possessionLost} passes lost (${player.passAccuracy}% accuracy)`);
  if (player.redCards > 0) concerns.push("Sent off");
  else if (player.yellowCards > 0) concerns.push("On a booking");
  if (player.fouls >= 2) concerns.push(`${player.fouls} fouls committed`);
  if (player.shots >= 3 && player.shotsOnTarget === 0) concerns.push(`${player.shots} shots, none on target`);
  const top = [...player.impact.components].sort((a, b) => b.value - a.value)[0];
  return {
    playerId: player.player.id,
    headline: `${player.player.name}: impact ${player.impact.rating.toFixed(1)}`,
    summary: player.involvements === 0
      ? `${player.player.name} has no logged actions yet.`
      : `${player.player.name} has ${player.involvements} logged actions (${player.involvementShare}% of the team's). ${top && top.value > 0 ? `Most of the impact comes from ${top.label.toLowerCase()}.` : `The impact rating sits near the ${IMPACT_RATING_BASELINE.toFixed(1)} baseline.`}`,
    strengths: strengths.slice(0, 3),
    concerns: concerns.slice(0, 3),
    source: "rules",
  };
}

export function createPlayerAnalyst(options: { endpoint?: string; invoke?: Invoke } = {}): PlayerAnalyst {
  let invoke = options.invoke;
  if (!invoke && options.endpoint) {
    const openai = new AIProjectClient(options.endpoint, getAzureCredential()).getOpenAIClient();
    const format = playerAnalystAgentSpec.definition.text?.format as { schema?: Record<string, unknown> } | undefined;
    invoke = (input) => invokeAgentJson(openai, PLAYER_ANALYST_AGENT_NAME, "player_note", format?.schema ?? {}, input, undefined, undefined, 0, 30_000);
  }
  const cache = new Map<string, PlayerNote>();
  return {
    configured: Boolean(invoke),
    async write(fixture, playerId, language, clockSecond, period = "full") {
      const { target, payload } = analystInput(fixture, playerId, language, clockSecond, period);
      const scoped = (note: PlayerNote): PlayerNote => ({ ...structuredClone(note), period, asOfSecond: clockSecond });
      const fallback = rulesNote(target);
      if (!invoke) return scoped(fallback);
      const key = JSON.stringify([fixture.id, language, period, payload]);
      const cached = cache.get(key);
      if (cached) return scoped(cached);
      let note: PlayerNote;
      try {
        const draft = noteSchema.parse(await invoke(JSON.stringify(payload)));
        const text = [draft.headline, draft.summary, ...draft.strengths, ...draft.concerns].join(" ");
        const modelNumbers = [IMPACT_RATING_BASELINE, IMPACT_RATING_SPAN, IMPACT_RATING_SCALE, IMPACT_RATING_MIN, IMPACT_RATING_MAX];
        const problems = groundingProblems(text, `${JSON.stringify(payload)} ${Object.values(IMPACT_WEIGHTS).join(" ")} ${modelNumbers.join(" ")}`, fixture);
        note = problems.length > 0
          ? { ...fallback, problem: `Agent note rejected: ${problems.join("; ")}` }
          : { playerId, ...draft, source: "foundry", agent: PLAYER_ANALYST_AGENT_NAME };
      } catch (error) {
        note = { ...fallback, problem: error instanceof Error ? error.message.slice(0, 200) : "Player analyst unavailable" };
      }
      if (note.source === "foundry") {
        cache.set(key, note);
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
      }
      return scoped(note);
    },
  };
}
