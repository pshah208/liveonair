import { createHash, randomUUID } from "node:crypto";

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
  }
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

export function guardDraftText(text: string, claimTexts: string[], knownNames: Set<string>): string | undefined {
  const reference = claimTexts.join(" \n ").toLowerCase();
  for (const token of numberTokens(text)) {
    if (!reference.includes(token.toLowerCase())) {
      return `Unsupported number token: ${token}`;
    }
  }
  for (const name of properNamesUsed(text, knownNames)) {
    if (!reference.includes(name.toLowerCase())) {
      return `Unsupported proper name: ${name}`;
    }
  }
  return undefined;
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
