import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { z } from "zod";

import type {
  ArchiveClub,
  ArchiveHonour,
  ArchiveMatch,
  ArchivePerson,
  ArchivePlayerProfile,
  ArchiveSnapshot,
  ClaimKind,
  ClaimSource,
  Localized,
  RelationKind,
  StorylineClaim,
  VerifiedFact,
} from "../../shared/platform.js";
import type { Language, MatchEvent, MatchFixture } from "../../shared/types.js";
import { LIVE_METRICS, liveMetricFact } from "../metricClaims.js";
import {
  buildChanceSequence,
  buildTerritory,
  chanceClaimNumbersForTeam,
  chanceClaimText,
  isChanceFixtureCamera,
  type ChanceClaimNumbers,
} from "../../shared/chanceSequence.js";

const boundedIdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9:_-]+$/u);
const claimSourceSchema = z.object({
  type: z.enum(["event", "archive"]),
  id: boundedIdSchema,
}).strict();

const familyLinkParamsSchema = z.object({
  personId: boundedIdSchema,
  relativeId: boundedIdSchema,
  relation: z.enum(["parent", "child", "sibling"]),
  matchId: boundedIdSchema,
  opponentClubId: boundedIdSchema.optional(),
}).strict();

const formerClubParamsSchema = z.object({
  personId: boundedIdSchema,
  clubId: boundedIdSchema,
  fromYear: z.number().int(),
  toYear: z.number().int(),
  goals: z.number().int().min(0),
}).strict();

const careerGoalsParamsSchema = z.object({
  personId: boundedIdSchema,
  total: z.number().int().min(0),
}).strict();

const headToHeadParamsSchema = z.object({
  clubAId: boundedIdSchema,
  clubBId: boundedIdSchema,
  clubAWins: z.number().int().min(0),
  clubBWins: z.number().int().min(0),
  draws: z.number().int().min(0),
}).strict();

const historicFinalParamsSchema = z.object({
  matchId: boundedIdSchema,
}).strict();

const clubHonourParamsSchema = z.object({
  clubId: boundedIdSchema,
  honourId: boundedIdSchema,
}).strict();

const liveEventParamsSchema = z.object({
  eventId: boundedIdSchema,
}).strict();

const matchStateParamsSchema = z.object({
  eventIds: z.array(boundedIdSchema).min(1).max(12),
}).strict();

const liveMetricParamsSchema = z.object({
  eventId: boundedIdSchema,
  metric: z.enum(LIVE_METRICS),
}).strict();

const chanceSequenceParamsSchema = z.object({
  shotEventId: boundedIdSchema,
  actions: z.number().int().min(1).max(10),
  passes: z.number().int().min(0).max(10),
  players: z.number().int().min(0).max(10),
  originZone: z.enum(["defensive", "middle", "final"]),
  progressionM: z.number().int().nullable(),
  matchClockSpanSeconds: z.number().int().min(0),
  boundary: z.enum(["turnover", "time_gap", "stoppage", "corner_origin", "action_cap", "match_start"]),
  ownHalf: z.boolean(),
  finalThirdEntries: z.number().int().nullable(),
  completedPassesEndingInFinalThird: z.number().int().nullable(),
  attackingActionsInFinalThird: z.number().int().min(0),
  attackingActions: z.number().int().min(0),
  windowMinutes: z.number().int().min(0),
}).strict();

export const claimProposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("family_link"), params: familyLinkParamsSchema, sources: z.array(claimSourceSchema).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("former_club"), params: formerClubParamsSchema, sources: z.array(claimSourceSchema).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("career_goals"), params: careerGoalsParamsSchema, sources: z.array(claimSourceSchema).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("head_to_head"), params: headToHeadParamsSchema, sources: z.array(claimSourceSchema).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("historic_final"), params: historicFinalParamsSchema, sources: z.array(claimSourceSchema).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("club_honour"), params: clubHonourParamsSchema, sources: z.array(claimSourceSchema).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("live_event"), params: liveEventParamsSchema, sources: z.array(claimSourceSchema).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("match_state"), params: matchStateParamsSchema, sources: z.array(claimSourceSchema).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("live_metric"), params: liveMetricParamsSchema, sources: z.array(claimSourceSchema).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("chance_sequence"), params: chanceSequenceParamsSchema, sources: z.array(claimSourceSchema).min(1).max(12) }).strict(),
]);

export const claimProposalArraySchema = z.array(claimProposalSchema).max(5);

export type ClaimProposal = z.infer<typeof claimProposalSchema>;
export type ClaimProposalKind = ClaimProposal["kind"];

export type ArchiveSearchHit = {
  id: string;
  title: string;
  body: string;
  recordIds: string[];
};

export type ArchiveRetrieval = {
  mode: "foundry-iq-knowledge-base" | "azure-ai-search-index" | "unconfigured";
  describe(): string;
  search(query: string): Promise<ArchiveSearchHit[]>;
};

export type VerifiedClaimResult =
  | { ok: true; claim: StorylineClaim; fact: VerifiedFact }
  | { ok: false; claim: StorylineClaim };

export type TriggerContext = {
  event: MatchEvent;
  fixture: MatchFixture;
  matchId: string;
  clockSecond: number;
  score: { home: number; away: number };
};

export type ArchiveIndexes = {
  clubs: Map<string, ArchiveClub>;
  people: Map<string, ArchivePerson>;
  matches: Map<string, ArchiveMatch>;
};

function localizeText(en: string, es: string, fr: string, pt: string): Localized {
  return { en, es, fr, pt };
}

export function buildArchiveIndexes(archive: ArchiveSnapshot): ArchiveIndexes {
  return {
    clubs: new Map(archive.clubs.map((club) => [club.id, club])),
    people: new Map(archive.people.map((person) => [person.id, person])),
    matches: new Map(archive.matches.map((match) => [match.id, match])),
  };
}

function eventSecond(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

export function activeEvents(fixture: MatchFixture, clockSecond = Number.POSITIVE_INFINITY): MatchEvent[] {
  const latest = new Map<string, MatchEvent>();
  for (const event of fixture.events) {
    if (eventSecond(event) > clockSecond) {
      continue;
    }
    const previous = latest.get(event.id);
    if (!previous || previous.revision <= event.revision) {
      latest.set(event.id, event);
    }
  }
  return [...latest.values()].sort((left, right) => eventSecond(left) - eventSecond(right) || left.id.localeCompare(right.id));
}

export function scoreFromEvents(events: MatchEvent[]): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const event of events) {
    if (event.type !== "goal" || event.rescinded) {
      continue;
    }
    if (event.teamId === "home") {
      home += 1;
    } else {
      away += 1;
    }
  }
  return { home, away };
}

function ordinalMinute(language: Language, minute: number): string {
  if (language === "es" || language === "fr") {
    return `${minute}'`;
  }
  return `${minute}'`;
}

function relationLabel(relation: RelationKind, language: Language): string {
  if (language === "es") {
    return relation === "parent" ? "padre o madre" : relation === "child" ? "hijo o hija" : "hermano o hermana";
  }
  if (language === "fr") {
    return relation === "parent" ? "parent" : relation === "child" ? "enfant" : "frère ou sœur";
  }
  if (language === "pt") {
    return relation === "parent" ? "pai ou mãe" : relation === "child" ? "filho ou filha" : "irmão ou irmã";
  }
  return relation === "parent" ? "parent" : relation === "child" ? "child" : "sibling";
}

function stageLabel(stage: ArchiveMatch["stage"], language: Language): string {
  const labels: Record<ArchiveMatch["stage"], Localized> = {
    final: { en: "final", es: "final", fr: "finale", pt: "final" },
    semi_final: { en: "semi-final", es: "semifinal", fr: "demi-finale", pt: "semifinal" },
    quarter_final: { en: "quarter-final", es: "cuartos de final", fr: "quart de finale", pt: "quartas de final" },
    league: { en: "league meeting", es: "partido de liga", fr: "match de championnat", pt: "jogo de liga" },
  };
  return labels[stage][language];
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function getFixturePlayerByArchiveId(fixture: MatchFixture, archiveId: string): { playerId: string; name: string } | undefined {
  const players = [...fixture.home.players, ...fixture.away.players];
  const player = players.find((candidate) => candidate.archiveId === archiveId);
  return player ? { playerId: player.id, name: player.name } : undefined;
}

function getFixtureClubByArchiveId(fixture: MatchFixture, archiveClubId: string): { name: string; side: "home" | "away" } | undefined {
  if (fixture.home.archiveClubId === archiveClubId) {
    return { name: fixture.home.name, side: "home" };
  }
  if (fixture.away.archiveClubId === archiveClubId) {
    return { name: fixture.away.name, side: "away" };
  }
  return undefined;
}

/** Documented career goals before the live match: the sum of archive career spells. */
function careerGoals(archive: ArchiveSnapshot, personId: string): number {
  const person = archive.people.find((candidate) => candidate.id === personId);
  return person ? person.career.reduce((total, spell) => total + spell.goals, 0) : 0;
}

function headToHead(archive: ArchiveSnapshot, clubAId: string, clubBId: string): { matches: number; clubAWins: number; clubBWins: number; draws: number } {
  let matches = 0;
  let clubAWins = 0;
  let clubBWins = 0;
  let draws = 0;
  for (const match of archive.matches) {
    const involvesA = match.homeClubId === clubAId || match.awayClubId === clubAId;
    const involvesB = match.homeClubId === clubBId || match.awayClubId === clubBId;
    if (!involvesA || !involvesB) {
      continue;
    }
    matches += 1;
    const clubAScore = match.homeClubId === clubAId ? match.homeScore : match.awayScore;
    const clubBScore = match.homeClubId === clubBId ? match.homeScore : match.awayScore;
    if (clubAScore > clubBScore) {
      clubAWins += 1;
    } else if (clubBScore > clubAScore) {
      clubBWins += 1;
    } else {
      draws += 1;
    }
  }
  return { matches, clubAWins, clubBWins, draws };
}

function relatives(archive: ArchiveSnapshot, personId: string): ArchivePerson[] {
  const person = archive.people.find((candidate) => candidate.id === personId);
  if (!person) {
    return [];
  }
  return person.relations
    .map((relation) => archive.people.find((candidate) => candidate.id === relation.personId))
    .filter((candidate): candidate is ArchivePerson => Boolean(candidate));
}

export function getPlayerProfile(archive: ArchiveSnapshot, archiveId: string): ArchivePlayerProfile | undefined {
  const person = archive.people.find((candidate) => candidate.id === archiveId);
  if (!person) {
    return undefined;
  }
  const clubIds = new Set<string>();
  for (const spell of person.career) {
    clubIds.add(spell.clubId);
  }
  if (person.currentClubId) {
    clubIds.add(person.currentClubId);
  }
  const clubs = Object.fromEntries(
    archive.clubs
      .filter((club) => clubIds.has(club.id))
      .map((club) => [club.id, club]),
  );
  const personName = person.name.toLowerCase();
  return {
    person,
    clubs,
    relatives: relatives(archive, person.id),
    documents: archive.documents.filter((document) => document.recordIds.includes(person.id) || document.body.toLowerCase().includes(personName)),
    careerGoals: careerGoals(archive, person.id),
  };
}

export function hashStateVersion(events: MatchEvent[]): string {
  return createHash("sha256").update(JSON.stringify(events.map((event) => ({
    id: event.id,
    revision: event.revision,
    rescinded: event.rescinded ?? false,
  })))).digest("hex").slice(0, 16);
}

function makeFactId(storylineId: string, claimId: string): string {
  return createHash("sha256").update(`${storylineId}:${claimId}`).digest("hex").slice(0, 20);
}

function buildLocalizedFact(
  storylineId: string,
  matchId: string,
  minute: number,
  claimId: string,
  text: Localized,
  sources: ClaimSource[],
  createdAt: string,
): VerifiedFact {
  return {
    id: makeFactId(storylineId, claimId),
    matchId,
    minute,
    text,
    sources,
    storylineId,
    createdAt,
  };
}

function rejectClaim(kind: ClaimKind, sources: ClaimSource[], reason: string): StorylineClaim {
  return {
    id: randomUUID(),
    kind,
    text: { en: "", es: "", fr: "", pt: "" },
    sources,
    status: "rejected",
    reason,
  };
}

function verifiedClaim(kind: ClaimKind, sources: ClaimSource[], text: Localized): StorylineClaim {
  return {
    id: randomUUID(),
    kind,
    text,
    sources,
    status: "verified",
  };
}

function verifyEventReference(event: MatchEvent | undefined, context: TriggerContext): string | undefined {
  if (!event) {
    return "Unknown event";
  }
  if (eventSecond(event) > context.clockSecond) {
    return "Event is in the future";
  }
  if (event.rescinded) {
    return "Event has been rescinded";
  }
  return undefined;
}

function archiveClub(indexes: ArchiveIndexes, id: string): ArchiveClub | undefined {
  return indexes.clubs.get(id);
}

function archivePerson(indexes: ArchiveIndexes, id: string): ArchivePerson | undefined {
  return indexes.people.get(id);
}

function archiveMatch(indexes: ArchiveIndexes, id: string): ArchiveMatch | undefined {
  return indexes.matches.get(id);
}

function familyLinkText(person: ArchivePerson, relative: ArchivePerson, relation: RelationKind, match: ArchiveMatch, opponent: ArchiveClub | undefined, language: Language): string {
  const stage = stageLabel(match.stage, language);
  if (language === "es") {
    return `${relative.name}, ${relationLabel(relation, language)} de ${person.name}, marcó en la ${stage} de ${match.competition} ${match.season}${opponent ? ` contra ${opponent.name}` : ""}.`;
  }
  if (language === "fr") {
    return `${relative.name}, ${relationLabel(relation, language)} de ${person.name}, a marqué lors de la ${stage} de ${match.competition} ${match.season}${opponent ? ` contre ${opponent.name}` : ""}.`;
  }
  if (language === "pt") {
    return `${relative.name}, ${relationLabel(relation, language)} de ${person.name}, marcou na ${stage} da ${match.competition} ${match.season}${opponent ? ` contra o ${opponent.name}` : ""}.`;
  }
  return `${relative.name}, ${person.name}'s ${relationLabel(relation, language)}, scored in the ${match.season} ${match.competition} ${stage}${opponent ? ` against ${opponent.name}` : ""}.`;
}

const archiveRecordPattern = /^(per|club|match|hon|doc)-/u;

/** Describes what a goal did to the scoreline, computed from active events before and including it. */
function goalEffect(fixture: MatchFixture, events: MatchEvent[], goal: MatchEvent): Localized {
  const before = scoreFromEvents(events.filter((event) => event.id !== goal.id && eventSecond(event) <= eventSecond(goal)));
  const team = goal.teamId === "home" ? fixture.home.name : fixture.away.name;
  const margin = goal.teamId === "home" ? before.home - before.away : before.away - before.home;
  if (margin === -1) {
    return { en: `The goal levelled the score for ${team}.`, es: `El gol igualó el marcador para ${team}.`, fr: `Le but a permis à ${team} d'égaliser.`, pt: `O gol deixou tudo igual para o ${team}.` };
  }
  if (margin === 0) {
    return { en: `The goal put ${team} ahead.`, es: `El gol puso por delante a ${team}.`, fr: `Le but a donné l'avantage à ${team}.`, pt: `O gol colocou o ${team} na frente.` };
  }
  if (margin > 0) {
    return { en: `The goal extended ${team}'s lead.`, es: `El gol amplió la ventaja de ${team}.`, fr: `Le but a creusé l'écart pour ${team}.`, pt: `O gol ampliou a vantagem do ${team}.` };
  }
  return { en: `The goal reduced ${team}'s deficit.`, es: `El gol recortó la desventaja de ${team}.`, fr: `Le but a réduit l'écart pour ${team}.`, pt: `O gol diminuiu a desvantagem do ${team}.` };
}

/** Every cited source must exist: live events must be active at the trigger clock, archive IDs must be real records. */
function verifySources(archive: ArchiveSnapshot, indexes: ArchiveIndexes, events: Map<string, MatchEvent>, context: TriggerContext, sources: ClaimSource[]): string | undefined {
  for (const source of sources) {
    if (source.type === "event") {
      const reason = verifyEventReference(events.get(source.id), context);
      if (reason) {
        return `Event source ${source.id}: ${reason}`;
      }
      continue;
    }
    const known = indexes.people.has(source.id)
      || indexes.clubs.has(source.id)
      || indexes.matches.has(source.id)
      || archive.clubs.some((club) => club.honours.some((honour) => honour.id === source.id))
      || archive.documents.some((document) => document.id === source.id);
    if (!known) {
      return `Unknown archive source ${source.id}${archiveRecordPattern.test(source.id) ? "" : " (not an archive record id)"}`;
    }
  }
  return undefined;
}

export function verifyClaimProposal(
  archive: ArchiveSnapshot,
  indexes: ArchiveIndexes,
  fixture: MatchFixture,
  context: TriggerContext,
  storylineId: string,
  createdAt: string,
  proposal: ClaimProposal,
): VerifiedClaimResult {
  const events = activeEvents(fixture, context.clockSecond);
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const actualScore = scoreFromEvents(events);
  const sourceProblem = verifySources(archive, indexes, eventsById, context, proposal.sources);
  if (sourceProblem) {
    return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, sourceProblem) };
  }
  switch (proposal.kind) {
    case "live_event": {
      const event = eventsById.get(proposal.params.eventId);
      const reason = verifyEventReference(event, context);
      if (!event || reason) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, reason ?? "Unknown event") };
      }
      const teamName = event.teamId === "home" ? fixture.home.name : fixture.away.name;
      const playerName = [...fixture.home.players, ...fixture.away.players].find((player) => player.id === event.playerId)?.name ?? "Unknown player";
      const text = event.type === "goal"
        ? localizeText(
          `${ordinalMinute("en", event.minute)} ${playerName} scored for ${teamName}.`,
          `${ordinalMinute("es", event.minute)} ${playerName} marcó para ${teamName}.`,
          `${ordinalMinute("fr", event.minute)} ${playerName} a marqué pour ${teamName}.`,
          `${ordinalMinute("pt", event.minute)} ${playerName} marcou para o ${teamName}.`,
        )
        : localizeText(
          `${ordinalMinute("en", event.minute)} ${playerName} was sent off for ${teamName}.`,
          `${ordinalMinute("es", event.minute)} ${playerName} fue expulsado con ${teamName}.`,
          `${ordinalMinute("fr", event.minute)} ${playerName} a été expulsé pour ${teamName}.`,
          `${ordinalMinute("pt", event.minute)} ${playerName} foi expulso pelo ${teamName}.`,
        );
      const claim = verifiedClaim(proposal.kind, proposal.sources, text);
      return {
        ok: true,
        claim,
        fact: buildLocalizedFact(storylineId, context.matchId, event.minute, claim.id, text, proposal.sources, createdAt),
      };
    }
    case "match_state": {
      const cited = proposal.params.eventIds.map((eventId) => eventsById.get(eventId));
      if (cited.some((event) => !event)) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Unknown match_state event") };
      }
      if (cited.some((event) => verifyEventReference(event, context))) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "match_state cites a future or rescinded event") };
      }
      const minute = Math.max(...cited.map((event) => event?.minute ?? context.event.minute), context.event.minute);
      const triggerCited = cited.some((event) => event?.id === context.event.id);
      const effect = triggerCited && context.event.type === "goal" && !context.event.rescinded
        ? goalEffect(fixture, events, context.event)
        : undefined;
      const text = localizeText(
        `${fixture.home.name} ${actualScore.home}-${actualScore.away} ${fixture.away.name} after ${minute} minutes.${effect ? ` ${effect.en}` : ""}`,
        `${fixture.home.name} ${actualScore.home}-${actualScore.away} ${fixture.away.name} tras ${minute} minutos.${effect ? ` ${effect.es}` : ""}`,
        `${fixture.home.name} ${actualScore.home}-${actualScore.away} ${fixture.away.name} après ${minute} minutes.${effect ? ` ${effect.fr}` : ""}`,
        `${fixture.home.name} ${actualScore.home}-${actualScore.away} ${fixture.away.name} após ${minute} minutos.${effect ? ` ${effect.pt}` : ""}`,
      );
      const claim = verifiedClaim(proposal.kind, proposal.sources, text);
      return {
        ok: true,
        claim,
        fact: buildLocalizedFact(storylineId, context.matchId, minute, claim.id, text, proposal.sources, createdAt),
      };
    }
    case "live_metric": {
      const event = eventsById.get(proposal.params.eventId);
      const reason = verifyEventReference(event, context);
      if (!event || reason) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, reason ?? "Unknown event") };
      }
      const computed = liveMetricFact(fixture, events, event, proposal.params.metric);
      if ("reason" in computed) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, computed.reason) };
      }
      const claim = verifiedClaim(proposal.kind, proposal.sources, computed.text);
      return {
        ok: true,
        claim,
        fact: buildLocalizedFact(storylineId, context.matchId, event.minute, claim.id, computed.text, proposal.sources, createdAt),
      };
    }
    case "former_club": {
      const person = archivePerson(indexes, proposal.params.personId);
      const club = archiveClub(indexes, proposal.params.clubId);
      if (!person || !club) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Unknown person or club") };
      }
      if (!getFixturePlayerByArchiveId(fixture, person.id)) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "former_club must describe a player in this match") };
      }
      if (!getFixtureClubByArchiveId(fixture, club.id)) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "former_club must cite one of the clubs in this match") };
      }
      const spell = person.career.find((entry) => entry.clubId === proposal.params.clubId && entry.fromYear === proposal.params.fromYear && entry.toYear === proposal.params.toYear);
      if (!spell || spell.toYear === null || person.currentClubId === club.id) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Completed career spell at that club not found") };
      }
      if (spell.goals !== proposal.params.goals) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Goal total does not match archive") };
      }
      const text = localizeText(
        `${person.name} scored ${spell.goals} goals for ${club.name} from ${spell.fromYear} to ${spell.toYear}.`,
        `${person.name} marcó ${spell.goals} goles con ${club.name} de ${spell.fromYear} a ${spell.toYear}.`,
        `${person.name} a marqué ${spell.goals} buts pour ${club.name} de ${spell.fromYear} à ${spell.toYear}.`,
        `${person.name} marcou ${spell.goals} gols pelo ${club.name} de ${spell.fromYear} a ${spell.toYear}.`,
      );
      const claim = verifiedClaim(proposal.kind, proposal.sources, text);
      return {
        ok: true,
        claim,
        fact: buildLocalizedFact(storylineId, context.matchId, context.event.minute, claim.id, text, proposal.sources, createdAt),
      };
    }
    case "family_link": {
      const person = archivePerson(indexes, proposal.params.personId);
      const relative = archivePerson(indexes, proposal.params.relativeId);
      const match = archiveMatch(indexes, proposal.params.matchId);
      const opponent = proposal.params.opponentClubId ? archiveClub(indexes, proposal.params.opponentClubId) : undefined;
      if (!person || !relative || !match) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Unknown archive record") };
      }
      if (!getFixturePlayerByArchiveId(fixture, person.id)) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "family_link must describe a player in this match") };
      }
      // params.relation is the relative's role relative to the player ("parent" = the relative is the player's parent),
      // matching ArchiveRelation semantics on the player's own record.
      const hasRelation = person.relations.some((relation) => relation.personId === relative.id && relation.kind === proposal.params.relation);
      if (!hasRelation) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Relation does not match archive") };
      }
      const relativeGoals = match.goals.filter((goal) => goal.personId === relative.id);
      if (relativeGoals.length === 0) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Relative did not score in the cited match") };
      }
      if (proposal.params.opponentClubId) {
        const involvesOpponent = match.homeClubId === proposal.params.opponentClubId || match.awayClubId === proposal.params.opponentClubId;
        const scoredAgainstOpponent = relativeGoals.some((goal) => goal.clubId !== proposal.params.opponentClubId);
        if (!involvesOpponent || !scoredAgainstOpponent) {
          return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Relative did not score against the cited opponent") };
        }
      }
      const text = localizeText(
        familyLinkText(person, relative, proposal.params.relation, match, opponent, "en"),
        familyLinkText(person, relative, proposal.params.relation, match, opponent, "es"),
        familyLinkText(person, relative, proposal.params.relation, match, opponent, "fr"),
        familyLinkText(person, relative, proposal.params.relation, match, opponent, "pt"),
      );
      const claim = verifiedClaim(proposal.kind, proposal.sources, text);
      return {
        ok: true,
        claim,
        fact: buildLocalizedFact(storylineId, context.matchId, context.event.minute, claim.id, text, proposal.sources, createdAt),
      };
    }
    case "career_goals": {
      const person = archivePerson(indexes, proposal.params.personId);
      if (!person) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Unknown person") };
      }
      const fixturePlayer = getFixturePlayerByArchiveId(fixture, proposal.params.personId);
      // Count every active live goal by this player up to the trigger, not just the trigger itself.
      const liveGoals = fixturePlayer
        ? events.filter((event) => event.type === "goal" && !event.rescinded && event.playerId === fixturePlayer.playerId).length
        : 0;
      const total = careerGoals(archive, person.id) + liveGoals;
      if (proposal.params.total !== total) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Career goals do not match archive") };
      }
      const text = localizeText(
        `${person.name} now has ${total} documented career goals.`,
        `${person.name} suma ahora ${total} goles documentados en su carrera.`,
        `${person.name} compte désormais ${total} buts documentés en carrière.`,
        `${person.name} soma agora ${total} gols documentados na carreira.`,
      );
      const claim = verifiedClaim(proposal.kind, proposal.sources, text);
      return {
        ok: true,
        claim,
        fact: buildLocalizedFact(storylineId, context.matchId, context.event.minute, claim.id, text, proposal.sources, createdAt),
      };
    }
    case "head_to_head": {
      const clubA = archiveClub(indexes, proposal.params.clubAId);
      const clubB = archiveClub(indexes, proposal.params.clubBId);
      if (!clubA || !clubB) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Unknown club") };
      }
      const tally = headToHead(archive, clubA.id, clubB.id);
      if (
        proposal.params.clubAWins !== tally.clubAWins ||
        proposal.params.clubBWins !== tally.clubBWins ||
        proposal.params.draws !== tally.draws
      ) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Head-to-head totals do not match archive") };
      }
      const text = localizeText(
        `${clubA.name} vs ${clubB.name}: ${plural(tally.clubAWins + tally.clubBWins + tally.draws, "meeting", "meetings")} in the archive, ${plural(tally.clubAWins, "win", "wins")} for ${clubA.name}, ${tally.clubBWins} for ${clubB.name}, ${plural(tally.draws, "draw", "draws")}.`,
        `${clubA.name} vs ${clubB.name}: ${plural(tally.clubAWins + tally.clubBWins + tally.draws, "enfrentamiento", "enfrentamientos")} en el archivo, ${plural(tally.clubAWins, "victoria", "victorias")} para ${clubA.name}, ${tally.clubBWins} para ${clubB.name} y ${plural(tally.draws, "empate", "empates")}.`,
        `${clubA.name} contre ${clubB.name} : ${plural(tally.clubAWins + tally.clubBWins + tally.draws, "confrontation", "confrontations")} dans les archives, ${plural(tally.clubAWins, "victoire", "victoires")} pour ${clubA.name}, ${tally.clubBWins} pour ${clubB.name} et ${plural(tally.draws, "nul", "nuls")}.`,
        `${clubA.name} x ${clubB.name}: ${plural(tally.clubAWins + tally.clubBWins + tally.draws, "confronto", "confrontos")} no arquivo, ${plural(tally.clubAWins, "vitória", "vitórias")} do ${clubA.name}, ${tally.clubBWins} do ${clubB.name} e ${plural(tally.draws, "empate", "empates")}.`,
      );
      const claim = verifiedClaim(proposal.kind, proposal.sources, text);
      return {
        ok: true,
        claim,
        fact: buildLocalizedFact(storylineId, context.matchId, context.event.minute, claim.id, text, proposal.sources, createdAt),
      };
    }
    case "historic_final": {
      const match = archiveMatch(indexes, proposal.params.matchId);
      const homeClub = match ? archiveClub(indexes, match.homeClubId) : undefined;
      const awayClub = match ? archiveClub(indexes, match.awayClubId) : undefined;
      if (!match || !homeClub || !awayClub) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Unknown archive match") };
      }
      if (match.stage !== "final") {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Cited match is not a final") };
      }
      const score = `${match.homeScore}-${match.awayScore}`;
      const text = match.homeScore === match.awayScore
        ? localizeText(
          `The ${match.season} ${match.competition} final between ${homeClub.name} and ${awayClub.name} finished ${score}.`,
          `La final ${match.season} de ${match.competition} entre ${homeClub.name} y ${awayClub.name} terminó ${score}.`,
          `La finale ${match.season} de ${match.competition} entre ${homeClub.name} et ${awayClub.name} s'est terminée sur le score de ${score}.`,
          `A final de ${match.season} da ${match.competition} entre ${homeClub.name} e ${awayClub.name} terminou ${score}.`,
        )
        : (() => {
          const [winner, loser] = match.homeScore > match.awayScore ? [homeClub, awayClub] : [awayClub, homeClub];
          const result = `${Math.max(match.homeScore, match.awayScore)}-${Math.min(match.homeScore, match.awayScore)}`;
          return localizeText(
            `In the ${match.season} ${match.competition} final, ${winner.name} beat ${loser.name} ${result}.`,
            `En la final ${match.season} de ${match.competition}, ${winner.name} venció a ${loser.name} por ${result}.`,
            `En finale ${match.season} de ${match.competition}, ${winner.name} a battu ${loser.name} ${result}.`,
            `Na final de ${match.season} da ${match.competition}, o ${winner.name} venceu o ${loser.name} por ${result}.`,
          );
        })();
      const claim = verifiedClaim(proposal.kind, proposal.sources, text);
      return {
        ok: true,
        claim,
        fact: buildLocalizedFact(storylineId, context.matchId, context.event.minute, claim.id, text, proposal.sources, createdAt),
      };
    }
    case "club_honour": {
      const club = archiveClub(indexes, proposal.params.clubId);
      const honour = club?.honours.find((candidate) => candidate.id === proposal.params.honourId);
      if (!club || !honour) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Unknown club honour") };
      }
      const resultText = honour.result === "winner" ? { en: "won", es: "ganó", fr: "a remporté", pt: "conquistou" } : { en: "finished runner-up in", es: "fue subcampeón en", fr: "a terminé finaliste de", pt: "foi vice-campeão da" };
      const text = localizeText(
        `${club.name} ${resultText.en} the ${honour.competition} in ${honour.season}.`,
        `${club.name} ${resultText.es} ${honour.competition} en ${honour.season}.`,
        `${club.name} ${resultText.fr} ${honour.competition} en ${honour.season}.`,
        `${club.name} ${resultText.pt} ${honour.competition} em ${honour.season}.`,
      );
      const claim = verifiedClaim(proposal.kind, proposal.sources, text);
      return {
        ok: true,
        claim,
        fact: buildLocalizedFact(storylineId, context.matchId, context.event.minute, claim.id, text, proposal.sources, createdAt),
      };
    }
    case "chance_sequence": {
      if (proposal.params.shotEventId !== context.event.id) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "chance_sequence must describe the trigger event") };
      }
      const shot = eventsById.get(proposal.params.shotEventId);
      const reason = verifyEventReference(shot, context);
      if (!shot || reason) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, reason ?? "Unknown event") };
      }
      if (shot.type !== "shot" && shot.type !== "goal") {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "chance_sequence needs a shot or goal") };
      }
      const sequence = buildChanceSequence(fixture.events, shot, isChanceFixtureCamera(fixture));
      if (!sequence) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "Chance sequence could not be computed") };
      }
      const territory = buildTerritory(fixture.events, shot);
      const expected = chanceClaimNumbersForTeam(sequence, territory, shot.teamId);
      const mismatch = chanceNumbersMismatch(expected, proposal.params);
      if (mismatch) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, mismatch) };
      }
      const cited = proposal.sources;
      const ids = sequence.eventIds;
      if (cited.length !== ids.length || cited.some((source, index) => source.type !== "event" || source.id !== ids[index])) {
        return { ok: false, claim: rejectClaim(proposal.kind, proposal.sources, "chance_sequence sources must list the sequence event ids in order") };
      }
      const teamName = shot.teamId === "home" ? fixture.home.name : fixture.away.name;
      const players = [...fixture.home.players, ...fixture.away.players];
      const names = sequence.playerIds
        .map((playerId) => players.find((player) => player.id === playerId)?.name)
        .filter((name): name is string => Boolean(name));
      const text = chanceClaimText(expected, teamName, names);
      const claim = verifiedClaim(proposal.kind, proposal.sources, text);
      return {
        ok: true,
        claim,
        fact: buildLocalizedFact(storylineId, context.matchId, shot.minute, claim.id, text, proposal.sources, createdAt),
      };
    }
  }
}

function chanceNumbersMismatch(expected: ChanceClaimNumbers, actual: ChanceClaimNumbers): string | undefined {
  const fields = Object.keys(expected) as (keyof ChanceClaimNumbers)[];
  for (const field of fields) {
    if (expected[field] !== actual[field]) {
      return `chance_sequence ${field} does not match the computed insight`;
    }
  }
  return undefined;
}

/** Deterministic chance-sequence proposal for a shot or goal trigger. The verifier recomputes the numbers. */
export function buildChanceSequenceProposal(fixture: MatchFixture, event: MatchEvent, clockSecond: number): ClaimProposal | null {
  if ((event.type !== "shot" && event.type !== "goal") || event.rescinded || eventSecond(event) > clockSecond) {
    return null;
  }
  const shot = activeEvents(fixture, clockSecond).find((candidate) => candidate.id === event.id);
  if (!shot || shot.rescinded || (shot.type !== "shot" && shot.type !== "goal")) {
    return null;
  }
  const sequence = buildChanceSequence(fixture.events, shot, isChanceFixtureCamera(fixture));
  if (!sequence) {
    return null;
  }
  const territory = buildTerritory(fixture.events, shot);
  return {
    kind: "chance_sequence",
    params: chanceClaimNumbersForTeam(sequence, territory, shot.teamId),
    sources: sequence.eventIds.map((id) => ({ type: "event", id })),
  };
}

export function knownNamesForGuard(archive: ArchiveSnapshot, fixture: MatchFixture): Set<string> {
  const names = new Set<string>();
  names.add(fixture.title);
  names.add(fixture.home.name);
  names.add(fixture.away.name);
  for (const club of archive.clubs) {
    names.add(club.name);
  }
  for (const person of archive.people) {
    names.add(person.name);
  }
  for (const player of [...fixture.home.players, ...fixture.away.players]) {
    names.add(player.name);
  }
  return names;
}

export function englishClaimTexts(claims: StorylineClaim[]): string[] {
  return claims.filter((claim) => claim.status === "verified").map((claim) => claim.text.en);
}

export function properNamesUsed(text: string, knownNames: Set<string>): string[] {
  const lowered = text.toLowerCase();
  return [...knownNames]
    .filter((name) => lowered.includes(name.toLowerCase()))
    .sort((left, right) => right.length - left.length);
}

export function numberTokens(text: string): string[] {
  return [...text.matchAll(/\b\d+\b/gu)].map((match) => match[0]);
}

/** Integer, decimal, percent or ordinal as one token. `12` is not a token of `123` or `12.5`. */
const COMPLETE_NUMBER = /\b\d+(?:\.\d+)?%|\b\d+(?:st|nd|rd|th)\b|\b\d+(?:\.\d+)?\b/giu;
/** Broadcast headline cap. Overlong headlines are rejected and retried, never trimmed. */
export const HEADLINE_COMPLETE_MAX = 60;

const TITLE_CASE_WORD = /^[A-Z][a-z]+(?:['\u2019-][A-Z][a-z]+)?$/u;

/** Articles, conjunctions, prepositions and pronouns. Not names, including in a name slot. */
const GRAMMAR_WORDS = new Set([
  "a", "an", "the", "and", "but", "or", "nor", "so", "yet",
  "in", "on", "at", "to", "for", "from", "with", "of", "by", "as",
  "after", "before", "during", "against", "into", "over", "under", "between",
  "vs", "versus", "v", "via", "per", "than", "if",
  "his", "her", "their", "its", "this", "that", "these", "those",
  "he", "she", "they", "it", "we", "i",
  "when", "what", "who", "which", "not", "no", "up", "out", "off", "down",
  "now", "then", "here", "there", "too", "also", "just", "only",
]);

/**
 * Months and weekdays, except May (a common surname). Authorises "in January",
 * not a name slot such as "June Scores".
 */
const CALENDAR_WORDS = new Set([
  "january", "february", "march", "april", "june",
  "july", "august", "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

/**
 * Plausible personal names and club suffixes. Vocabulary must never authorise these.
 * A capitalised token still passes when it is a known fixture name or an exact claim token.
 */
const NAME_LIKE_WORDS = new Set([
  "young", "hope", "rich", "stone", "best", "king", "black", "white", "green", "brown",
  "rose", "may", "bright", "hill", "wood", "hart", "cole", "long", "little", "moore",
  "hall", "field", "park", "city", "united", "town", "rovers", "athletic",
  "wanderers", "rangers", "albion", "county",
]);

/**
 * Closed football and headline spellings. Inflections are listed here; nothing is stemmed.
 * Scores/Scored, Levels/Levelled, Equalises, Wins/Winner, Matches, Goal, Late, Header, Penalty.
 */
const HEADLINE_FORMS = new Set([
  "goal", "goals", "winner", "winners",
  "equaliser", "equalisers", "equalizer", "equalizers",
  "leveller", "levellers", "leveler", "levelers",
  "header", "headers", "volley", "volleys",
  "penalty", "penalties",
  "shot", "shots", "save", "saves", "saved",
  "assist", "assists", "chance", "chances",
  "match", "matches", "matched",
  "game", "games", "fixture", "fixtures", "derby",
  "final", "finals",
  "score", "scores", "scored", "scoreline", "scorelines",
  "lead", "leads", "led",
  "level", "levels", "levelled", "leveled",
  "draw", "draws", "drawn",
  "win", "wins", "won",
  "loss", "losses", "defeat", "defeats",
  "comeback", "comebacks", "fightback", "fightbacks", "turnaround",
  "brace", "treble",
  "kick", "kicks", "kicked",
  "strike", "strikes", "struck",
  "net", "nets", "netted",
  "box", "half", "minute", "minutes",
  "stoppage", "injury", "added", "extra", "full", "time",
  "whistle", "offside", "corner", "corners",
  "counter", "attack", "attacks",
  "defence", "defense", "midfield",
  "press", "pressure", "line", "block",
  "possession", "territory", "sequence",
  "build", "buildup", "move", "moves",
  "pass", "passes", "passed",
  "cross", "crosses", "crossed",
  "dribble", "tackle", "clearance",
  "keeper", "goalkeeper",
  "striker", "forward", "winger", "midfielder", "defender",
  "captain", "skipper", "substitute", "bench", "squad",
  "side", "team", "club", "home", "away",
  "host", "hosts", "visitor", "visitors", "rival", "rivals",
  "opener", "clincher", "finish", "finishes", "finished",
  "moment", "night", "drama",
  "cup", "season", "history", "career", "milestone",
  "honour", "honor", "title", "trophy",
  "champion", "champions",
  "card", "cards", "booking", "dismissal", "rebound", "spot",
  "hat-trick", "hattrick",
  "extra-time", "full-time", "half-time", "stoppage-time", "injury-time", "added-time",
  "equalise", "equalises", "equalised", "equalize", "equalizes", "equalized",
  "miss", "misses", "missed",
  "hit", "hits",
  "convert", "converts", "converted",
  "slot", "slots", "slotted",
  "fire", "fires", "fired",
  "head", "heads", "headed",
  "create", "creates", "created",
  "force", "forces", "forced",
  "earn", "earns", "earned",
  "claim", "claims", "claimed",
  "secure", "secures", "secured",
  "restore", "restores", "restored",
  "extend", "extends", "extended",
  "double", "doubles", "doubled",
  "complete", "completes", "completed",
  "open", "opens", "opened",
  "break", "breaks", "broke", "broken",
  "rescue", "rescues", "rescued",
  "deny", "denies", "denied",
  "stop", "stops", "stopped",
  "keep", "keeps", "kept",
  "hold", "holds", "held",
  "grab", "grabs", "grabbed",
  "take", "takes", "took", "taken",
  "make", "makes", "made",
  "give", "gives", "gave", "given",
  "find", "finds", "found",
  "put", "puts",
  "see", "sees", "saw", "seen",
  "come", "comes", "came",
  "go", "goes", "went", "gone",
  "get", "gets", "got",
  "have", "has", "had",
  "need", "needs", "needed",
  "look", "looks", "looked",
  "stay", "stays", "stayed",
  "remain", "remains", "remained",
  "trail", "trails", "trailed",
  "seal", "seals", "sealed",
  "snatch", "snatches", "snatched",
  "spark", "sparks", "sparked",
  "lift", "lifts", "lifted",
  "send", "sends", "sent",
  "pull", "pulls", "pulled",
  "push", "pushes", "pushed",
  "turn", "turns", "turned",
  "edge", "edges", "edged",
  "bundle", "bundles", "bundled",
  "nod", "nods", "nodded",
  "tap", "taps", "tapped",
  "drill", "drills", "drilled",
  "smash", "smashes", "smashed",
  "curl", "curls", "curled",
  "place", "places", "placed",
  "bury", "buries", "buried",
  "poke", "pokes", "poked",
  "guide", "guides", "guided",
  "hammer", "hammers", "hammered",
  "rifle", "rifles", "rifled",
  "blast", "blasts", "blasted",
  "power", "powers", "powered",
  "echo", "echoes", "echoed",
  "link", "links", "linked",
  "arrive", "arrives", "arrived",
  "settle", "settles", "settled",
  "reduce", "reduces", "reduced",
  "start", "starts", "started",
  "end", "ends", "ended",
  "begin", "begins", "began",
  "follow", "follows", "followed",
  "let", "lets",
  "help", "helps", "helped",
  "do", "does", "did", "done",
  "can", "will", "would", "could", "should", "might", "must",
  "was", "were", "been", "are", "is",
  "late", "early", "dramatic", "stunning", "crucial", "vital", "decisive", "clinical",
  "instant", "rapid", "swift", "quick",
  "brilliant", "superb", "historic", "former",
  "opening", "closing", "another", "further",
  "back", "ahead", "behind", "deep", "wide", "closer",
  "short", "high", "low", "big", "huge", "massive", "great",
  "poor", "remarkable", "famous",
  "last", "first", "second", "third", "fourth",
  "own", "both", "each", "every", "some", "any",
  "still", "again", "today", "tonight",
  "already", "even", "very", "all",
  "never", "always", "more", "most", "less", "least",
  "yellow", "red",
]);

/** Nouns that may sit immediately before a headline verb ("Goal Wins", "Header Levels"). Not names. */
const HEADLINE_SUBJECT_NOUNS = new Set([
  "goal", "goals",
  "header", "headers", "penalty", "penalties",
  "equaliser", "equalisers", "equalizer", "equalizers",
  "leveller", "levellers", "leveler", "levelers",
  "shot", "shots", "strike", "strikes", "save", "saves",
  "volley", "volleys", "comeback", "comebacks",
  "opener", "clincher", "treble",
]);

/** Player or team actions. The word before one of these is a name slot, not a vocabulary slot. */
const NAME_VERBS = new Set([
  "score", "scores", "scored",
  "level", "levels", "levelled", "leveled",
  "equalise", "equalises", "equalised", "equalize", "equalizes", "equalized",
  "win", "wins", "won",
  "strike", "strikes", "struck",
  "net", "nets", "netted",
]);

const NAME_PREPOSITIONS = new Set(["for", "by", "against", "from", "v", "vs", "versus"]);

type DraftWord = { raw: string; lower: string; clauseStart: boolean };

export function completeNumericTokens(text: string): string[] {
  return [...text.matchAll(COMPLETE_NUMBER)].map((match) => match[0].toLowerCase());
}

function wordsOf(text: string): DraftWord[] {
  let lastEnd = 0;
  return [...text.matchAll(/[A-Za-z]+(?:['\u2019-][A-Za-z]+)*/gu)].map((match) => {
    const start = match.index ?? 0;
    // Any non-space separator (":", ".", "-", "|", quotes...) or the start of the text opens a new clause.
    const clauseStart = start === 0 || lastEnd === 0 || /[^\s]/u.test(text.slice(lastEnd, start));
    lastEnd = start + match[0].length;
    return { raw: match[0], lower: match[0].toLowerCase(), clauseStart };
  });
}

function exactWordSet(texts: Iterable<string>): Set<string> {
  const words = new Set<string>();
  for (const text of texts) {
    for (const word of wordsOf(text)) words.add(word.lower);
  }
  return words;
}

function isSafeHeadlineWord(lower: string): boolean {
  if (NAME_LIKE_WORDS.has(lower)) return false;
  return GRAMMAR_WORDS.has(lower) || CALENDAR_WORDS.has(lower) || HEADLINE_FORMS.has(lower);
}

function isTitleCaseWord(raw: string): boolean {
  return TITLE_CASE_WORD.test(raw);
}

let englishWords: Set<string> | undefined;

/** Ordinary English words (MIT word list). Never authorises a name slot, and excludes surname-like words. */
function isDictionaryWord(lower: string): boolean {
  if (NAME_LIKE_WORDS.has(lower)) return false;
  englishWords ??= new Set(createRequire(import.meta.url)("an-array-of-english-words") as string[]);
  return englishWords.has(lower);
}

/** Sentence case: the text has a lowercase content word mid-clause, so Title Case tolerance does not apply. */
function isSentenceCase(words: DraftWord[]): boolean {
  return words.some((word) => !word.clauseStart && /^[a-z]/u.test(word.raw) && !GRAMMAR_WORDS.has(word.lower));
}

/**
 * Name slot: subject before Scores/Levels/Wins/Equalises/Strikes/Nets, object of
 * for/by/against/from/v/vs, or a non-vocabulary token beside another capitalised name.
 * Vocabulary cannot fill these slots, except a closed headline noun before a verb ("Goal Wins").
 */
function nameSlot(words: DraftWord[], index: number): "preposition" | "subject" | "cluster" | undefined {
  const word = words[index];
  if (!word || !isTitleCaseWord(word.raw)) return undefined;
  const previous = words[index - 1];
  const next = words[index + 1];
  if (previous && NAME_PREPOSITIONS.has(previous.lower)) return "preposition";
  if (next && NAME_VERBS.has(next.lower)) return "subject";
  const nonVocabName = (candidate: DraftWord | undefined) =>
    candidate !== undefined && isTitleCaseWord(candidate.raw) && !isSafeHeadlineWord(candidate.lower) && !isDictionaryWord(candidate.lower);
  if (!isSafeHeadlineWord(word.lower) && ((!word.clauseStart && nonVocabName(previous)) || (next !== undefined && !next.clauseStart && nonVocabName(next)))) return "cluster";
  return undefined;
}

/**
 * A capitalised token must be a known name or an exact claim token.
 * Stemming is not used: "hoped" does not authorise "Hope", and "stoned" does not authorise "Stone".
 * Vocabulary and ordinary English words may be capitalised outside a name slot (Title Case, clause starts);
 * in sentence-case text a mid-clause capital must be a name, a claim token or closed headline vocabulary.
 */
function unsupportedTitleCaseName(text: string, claimTexts: string[], knownNames: Set<string>): string | undefined {
  const claimWords = exactWordSet(claimTexts);
  const knownWords = exactWordSet(knownNames);
  const words = wordsOf(text);
  const sentenceCase = isSentenceCase(words);
  const isKnown = (word: DraftWord | undefined) => word !== undefined && (claimWords.has(word.lower) || knownWords.has(word.lower));
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!isTitleCaseWord(word.raw)) continue;
    const knownEntity = isKnown(word);
    const previous = words[index - 1];
    let slot = nameSlot(words, index);
    // "Arden Levels Score": a verb straight after a known name is the predicate, not a new subject.
    if (slot === "subject" && !word.clauseStart && HEADLINE_FORMS.has(word.lower) && previous && isTitleCaseWord(previous.raw) && isKnown(previous)) {
      slot = undefined;
    }
    if (slot === "preposition" || slot === "cluster") {
      if (slot === "preposition" && GRAMMAR_WORDS.has(word.lower)) continue;
      if (!knownEntity) return `Unsupported proper name: ${word.raw}`;
      continue;
    }
    if (slot === "subject") {
      // A bare noun opening a clause before a scoring verb reads as a name ("Brace Scores"); require a modifier ("Late Goal Wins").
      const modified = previous !== undefined && !word.clauseStart && !GRAMMAR_WORDS.has(previous.lower) && !NAME_VERBS.has(previous.lower)
        && (isSafeHeadlineWord(previous.lower) || isKnown(previous));
      if (knownEntity || GRAMMAR_WORDS.has(word.lower) || (modified && HEADLINE_SUBJECT_NOUNS.has(word.lower) && !NAME_LIKE_WORDS.has(word.lower))) continue;
      return `Unsupported proper name: ${word.raw}`;
    }
    if (knownEntity || isSafeHeadlineWord(word.lower)) continue;
    if ((word.clauseStart || !sentenceCase) && isDictionaryWord(word.lower)) continue;
    return `Unsupported proper name: ${word.raw}`;
  }
  return undefined;
}

export function guardDraftText(text: string, claimTexts: string[], knownNames: Set<string>): string | undefined {
  const allowedNumbers = new Set(claimTexts.flatMap(completeNumericTokens));
  for (const token of completeNumericTokens(text)) {
    if (!allowedNumbers.has(token)) {
      return `Unsupported number token: ${token}`;
    }
  }
  const reference = claimTexts.join(" \n ").toLowerCase();
  for (const name of properNamesUsed(text, knownNames)) {
    if (!reference.includes(name.toLowerCase())) {
      return `Unsupported proper name: ${name}`;
    }
  }
  return unsupportedTitleCaseName(text, claimTexts, knownNames);
}

export function guardLocalization(source: string, localized: string, knownNames: Set<string>): string | undefined {
  const localizedLower = localized.toLowerCase();
  for (const token of numberTokens(source)) {
    if (!localizedLower.includes(token.toLowerCase())) {
      return `Missing number token: ${token}`;
    }
  }
  for (const name of properNamesUsed(source, knownNames)) {
    if (!localizedLower.includes(name.toLowerCase())) {
      return `Missing proper name: ${name}`;
    }
  }
  return undefined;
}

export function outputWordCount(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/u).length;
}

export function summariseClubHonours(club: ArchiveClub): ArchiveHonour[] {
  return [...club.honours];
}
