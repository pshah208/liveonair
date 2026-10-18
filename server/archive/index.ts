import type {
  ArchiveClub,
  ArchiveDocument,
  ArchiveGoal,
  ArchiveMatch,
  ArchiveNewsItem,
  ArchivePerson,
  ArchivePlayerProfile,
  ArchiveSnapshot,
} from "../../shared/platform.js";
import { ARCHIVE_VERSION, clubs, matches, people } from "./data.js";
import { newsItems } from "./news.js";

type HistoricGoalRecord = { goal: ArchiveGoal; match: ArchiveMatch };

const recordIdSet = new Set<string>();
for (const club of clubs) {
  recordIdSet.add(club.id);
  for (const honour of club.honours) {
    recordIdSet.add(honour.id);
  }
}
for (const person of people) {
  recordIdSet.add(person.id);
}
for (const match of matches) {
  recordIdSet.add(match.id);
}
for (const item of newsItems) {
  recordIdSet.add(item.id);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function clubMap(): Map<string, ArchiveClub> {
  return new Map(clubs.map((club) => [club.id, club]));
}

function peopleMap(): Map<string, ArchivePerson> {
  return new Map(people.map((person) => [person.id, person]));
}

const clubsById = clubMap();
const peopleById = peopleMap();

function careerGoalsRaw(personId: string): number {
  const person = peopleById.get(personId);
  if (!person) {
    throw new RangeError(`Unknown archive person: ${personId}`);
  }
  return person.career.reduce((sum, spell) => sum + spell.goals, 0);
}

function relativesRaw(personId: string): ArchivePerson[] {
  const person = peopleById.get(personId);
  if (!person) {
    throw new RangeError(`Unknown archive person: ${personId}`);
  }
  return person.relations
    .map((relation) => peopleById.get(relation.personId))
    .filter((candidate): candidate is ArchivePerson => Boolean(candidate))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function historicGoalsRaw(personId: string): HistoricGoalRecord[] {
  return matches
    .flatMap((match) => match.goals
      .filter((goal) => goal.personId === personId)
      .map((goal) => ({ goal, match })))
    .sort((a, b) => a.match.date.localeCompare(b.match.date) || a.goal.minute - b.goal.minute || a.match.id.localeCompare(b.match.id));
}

function renderPlayerProfileDocument(person: ArchivePerson): ArchiveDocument {
  const goalTotal = careerGoalsRaw(person.id);
  const careerLine = person.career
    .map((spell) => {
      const club = clubsById.get(spell.clubId);
      const range = `${spell.fromYear}-${spell.toYear ?? "present"}`;
      return `${club?.name ?? spell.clubId} ${range}: ${spell.appearances} apps, ${spell.goals} goals`;
    })
    .join("; ");
  const relativeNames = relativesRaw(person.id).map((relative) => relative.name).join(", ");
  const status = person.retired ? "Retired" : `Current club: ${clubsById.get(person.currentClubId ?? "")?.name ?? "unattached"}`;
  return {
    id: `doc-player-${person.id}`,
    kind: "player_profile",
    title: `${person.name} archive profile`,
    body: `${person.name} (${person.position}, b. ${person.birthYear}, ${person.hometown}). ${status}. Career goals: ${goalTotal}. Career spells: ${careerLine}.${relativeNames ? ` Relatives in archive: ${relativeNames}.` : ""}`,
    recordIds: [person.id, ...person.career.map((spell) => spell.clubId)],
  };
}

function isPlayer(person: ArchivePerson): boolean {
  return !person.role || person.role === "player";
}

function renderClubHistoryDocument(club: ArchiveClub): ArchiveDocument {
  const honoursLine = club.honours
    .map((honour) => `${honour.season} ${honour.competition} ${honour.result.replace("_", " ")}`)
    .join("; ");
  const notablePlayers = people
    .filter((person) => person.currentClubId === club.id && isPlayer(person))
    .map((person) => person.name)
    .slice(0, 6)
    .join(", ");
  const headCoach = people.find((person) => person.role === "head_coach" && person.currentClubId === club.id && !person.retired);
  return {
    id: `doc-club-${club.id}`,
    kind: "club_history",
    title: `${club.name} club history`,
    body: `${club.name} (${club.shortName}) of ${club.city}, founded ${club.founded}, play at ${club.stadium}. Honours: ${honoursLine || "none recorded"}. Current head coach: ${headCoach?.name ?? "not recorded"}. Current archive roster sample: ${notablePlayers}.`,
    recordIds: [club.id, ...club.honours.map((honour) => honour.id), ...club.honours.map((honour) => honour.finalMatchId).filter((value): value is string => Boolean(value)), ...(headCoach ? [headCoach.id] : [])],
  };
}

function renderManagerDocument(person: ArchivePerson): ArchiveDocument {
  const club = person.currentClubId ? clubsById.get(person.currentClubId) : undefined;
  const record = person.staffRecord;
  const recordLine = record
    ? `Record: ${record.matches} matches, ${record.wins} wins, ${record.draws} draws, ${record.losses} losses.`
    : "";
  return {
    id: `doc-manager-${person.id}`,
    kind: "manager_profile",
    title: `${person.name} coaching profile`,
    body: `${person.name} is ${person.retired ? "a former" : "the current"} ${person.position.toLowerCase()} ${club ? `of ${club.name}` : "in the synthetic archive"}. ${person.tenureNotes ?? ""} ${recordLine}`.replace(/\s+/gu, " ").trim(),
    recordIds: [person.id, ...person.career.map((spell) => spell.clubId), ...(person.notableMatchIds ?? [])],
  };
}

function renderNewsDocument(item: ArchiveNewsItem): ArchiveDocument {
  return {
    id: `doc-${item.id}`,
    kind: "news_wire",
    title: item.headline,
    body: `${item.outlet} (${item.publishedAt}, synthetic): ${item.headline}. ${item.body}`,
    recordIds: [item.id, ...item.clubIds, ...item.personIds],
  };
}

function renderMatchReportDocument(match: ArchiveMatch): ArchiveDocument {
  const homeClub = clubsById.get(match.homeClubId);
  const awayClub = clubsById.get(match.awayClubId);
  const goalsLine = match.goals
    .map((goal) => {
      const person = peopleById.get(goal.personId);
      const club = clubsById.get(goal.clubId);
      return `${goal.minute}' ${person?.name ?? goal.personId} (${club?.shortName ?? goal.clubId})`;
    })
    .join(", ");
  return {
    id: `doc-match-${match.id}`,
    kind: "match_report",
    title: `${homeClub?.name ?? match.homeClubId} ${match.homeScore}-${match.awayScore} ${awayClub?.name ?? match.awayClubId}`,
    body: `${match.competition} ${match.stage.replace("_", " ")} on ${match.date} at ${match.venue}. Final score: ${homeClub?.name ?? match.homeClubId} ${match.homeScore}, ${awayClub?.name ?? match.awayClubId} ${match.awayScore}. Goals: ${goalsLine || "none"}.`,
    recordIds: [match.id, ...match.goals.map((goal) => goal.personId)],
  };
}

function relationDocumentId(personAId: string, personBId: string): string {
  return [personAId, personBId].sort().join("--");
}

function renderFamilyDocuments(): ArchiveDocument[] {
  const docs = new Map<string, ArchiveDocument>();
  for (const person of people) {
    for (const relation of person.relations) {
      // relation.kind is the role of relation.personId relative to `person` ("parent" = other is person's parent).
      if (relation.kind === "parent") {
        const other = peopleById.get(relation.personId);
        if (!other) continue;
        const id = relationDocumentId(person.id, other.id);
        docs.set(id, {
          id: `doc-family-${id}`,
          kind: "family_note",
          title: `${person.name} family link`,
          body: `${other.name} is the parent of ${person.name}. ${other.name} recorded ${historicGoalsRaw(other.id).filter((entry) => entry.match.stage === "final").length} final-stage goals in the archive timeline.`,
          recordIds: [person.id, other.id],
        });
      }
      if (relation.kind === "sibling") {
        const other = peopleById.get(relation.personId);
        if (!other) continue;
        const id = relationDocumentId(person.id, other.id);
        docs.set(id, {
          id: `doc-family-${id}`,
          kind: "family_note",
          title: `${person.name} sibling note`,
          body: `${person.name} and ${other.name} are listed as siblings in the synthetic archive.`,
          recordIds: [person.id, other.id],
        });
      }
    }
  }
  return [...docs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function buildDocuments(): ArchiveDocument[] {
  return [
    ...people.filter(isPlayer).map(renderPlayerProfileDocument),
    ...people.filter((person) => person.role === "head_coach" || person.role === "assistant_coach").map(renderManagerDocument),
    ...clubs.map(renderClubHistoryDocument),
    ...matches.map(renderMatchReportDocument),
    ...renderFamilyDocuments(),
    ...newsItems.map(renderNewsDocument),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

const archive: ArchiveSnapshot = {
  version: ARCHIVE_VERSION,
  clubs: clone(clubs),
  people: clone(people),
  matches: clone(matches),
  documents: buildDocuments(),
  news: clone(newsItems),
};

export function getArchive(): ArchiveSnapshot {
  return clone(archive);
}

export function getPerson(id: string): ArchivePerson {
  const person = peopleById.get(id);
  if (!person) {
    throw new RangeError(`Unknown archive person: ${id}`);
  }
  return clone(person);
}

export function getClub(id: string): ArchiveClub {
  const club = clubsById.get(id);
  if (!club) {
    throw new RangeError(`Unknown archive club: ${id}`);
  }
  return clone(club);
}

export function careerGoals(personId: string): number {
  return careerGoalsRaw(personId);
}

export function headToHead(clubA: string, clubB: string): { matches: ArchiveMatch[]; clubAWins: number; clubBWins: number; draws: number } {
  const relevantMatches = matches.filter((match) => {
    return (
      (match.homeClubId === clubA && match.awayClubId === clubB) ||
      (match.homeClubId === clubB && match.awayClubId === clubA)
    );
  });

  let clubAWins = 0;
  let clubBWins = 0;
  let draws = 0;
  for (const match of relevantMatches) {
    const clubAScore = match.homeClubId === clubA ? match.homeScore : match.awayScore;
    const clubBScore = match.homeClubId === clubB ? match.homeScore : match.awayScore;
    if (clubAScore > clubBScore) {
      clubAWins += 1;
    } else if (clubBScore > clubAScore) {
      clubBWins += 1;
    } else {
      draws += 1;
    }
  }

  return {
    matches: clone(relevantMatches),
    clubAWins,
    clubBWins,
    draws,
  };
}

export function personHistoricGoals(personId: string): HistoricGoalRecord[] {
  if (!peopleById.has(personId)) {
    throw new RangeError(`Unknown archive person: ${personId}`);
  }
  return clone(historicGoalsRaw(personId));
}

export function relatives(personId: string): ArchivePerson[] {
  return clone(relativesRaw(personId));
}

export function validateArchive(snapshot: ArchiveSnapshot): string[] {
  const errors: string[] = [];
  const clubIds = new Set(snapshot.clubs.map((club) => club.id));
  const peopleIds = new Set(snapshot.people.map((person) => person.id));
  const matchIds = new Set(snapshot.matches.map((match) => match.id));
  const documentIds = new Set<string>();

  for (const club of snapshot.clubs) {
    for (const honour of club.honours) {
      if (!honour.finalMatchId || !matchIds.has(honour.finalMatchId)) {
        errors.push(`Honour ${honour.id} in ${club.id} references missing final`);
        continue;
      }
      const finalMatch = snapshot.matches.find((match) => match.id === honour.finalMatchId);
      if (!finalMatch) {
        continue;
      }
      if (finalMatch.homeClubId !== club.id && finalMatch.awayClubId !== club.id) {
        errors.push(`Honour ${honour.id} references final ${finalMatch.id} without club participation`);
      }
      const clubScore = finalMatch.homeClubId === club.id ? finalMatch.homeScore : finalMatch.awayScore;
      const oppScore = finalMatch.homeClubId === club.id ? finalMatch.awayScore : finalMatch.homeScore;
      if (honour.result === "winner" && clubScore <= oppScore) {
        errors.push(`Honour ${honour.id} says winner but score is not a win`);
      }
      if (honour.result === "runner_up" && clubScore >= oppScore) {
        errors.push(`Honour ${honour.id} says runner_up but score is not a loss`);
      }
    }
  }

  for (const person of snapshot.people) {
    if (person.currentClubId !== null && !clubIds.has(person.currentClubId)) {
      errors.push(`Person ${person.id} has unknown current club ${person.currentClubId}`);
    }
    let lastToYear = -Infinity;
    for (const spell of person.career) {
      if (!clubIds.has(spell.clubId)) {
        errors.push(`Person ${person.id} has unknown club spell ${spell.clubId}`);
      }
      if (spell.toYear !== null && spell.toYear < spell.fromYear) {
        errors.push(`Person ${person.id} has reverse spell years ${spell.clubId}`);
      }
      if (spell.fromYear < lastToYear) {
        errors.push(`Person ${person.id} has non-chronological spells`);
      }
      lastToYear = spell.toYear ?? Number.MAX_SAFE_INTEGER;
    }
    for (const relation of person.relations) {
      if (!peopleIds.has(relation.personId)) {
        errors.push(`Person ${person.id} has missing relation target ${relation.personId}`);
        continue;
      }
      const related = snapshot.people.find((candidate) => candidate.id === relation.personId);
      const expectedKind = relation.kind === "parent" ? "child" : relation.kind === "child" ? "parent" : "sibling";
      if (!related?.relations.some((entry) => entry.personId === person.id && entry.kind === expectedKind)) {
        errors.push(`Relation ${person.id} -> ${relation.personId} is not symmetric`);
      }
    }
  }

  for (const match of snapshot.matches) {
    if (!clubIds.has(match.homeClubId) || !clubIds.has(match.awayClubId)) {
      errors.push(`Match ${match.id} references unknown club`);
    }
    if (match.date > "2026-05-31") {
      errors.push(`Match ${match.id} is dated after allowed cutoff`);
    }
    const homeGoals = match.goals.filter((goal) => goal.clubId === match.homeClubId).length;
    const awayGoals = match.goals.filter((goal) => goal.clubId === match.awayClubId).length;
    if (homeGoals !== match.homeScore || awayGoals !== match.awayScore) {
      errors.push(`Match ${match.id} score does not match goal ledger`);
    }
    for (const goal of match.goals) {
      if (!peopleIds.has(goal.personId)) {
        errors.push(`Match ${match.id} has goal by missing person ${goal.personId}`);
      }
      if (goal.clubId !== match.homeClubId && goal.clubId !== match.awayClubId) {
        errors.push(`Match ${match.id} has goal for unrelated club ${goal.clubId}`);
      }
    }
  }

  for (const item of snapshot.news ?? []) {
    if (!item.synthetic || item.outlet.trim().length === 0) {
      errors.push(`News item ${item.id} must be labelled synthetic`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(item.publishedAt)) {
      errors.push(`News item ${item.id} has an invalid date`);
    }
    for (const clubId of item.clubIds) {
      if (!clubIds.has(clubId)) errors.push(`News item ${item.id} references unknown club ${clubId}`);
    }
    for (const personId of item.personIds) {
      if (!peopleIds.has(personId)) errors.push(`News item ${item.id} references unknown person ${personId}`);
    }
  }

  for (const person of snapshot.people) {
    for (const matchId of person.notableMatchIds ?? []) {
      if (!matchIds.has(matchId)) errors.push(`Person ${person.id} references missing notable match ${matchId}`);
    }
    if (person.staffRecord) {
      const { matches: played, wins, draws, losses } = person.staffRecord;
      if (wins + draws + losses !== played) {
        errors.push(`Person ${person.id} staff record does not add up`);
      }
    }
  }

  for (const document of snapshot.documents) {
    if (documentIds.has(document.id)) {
      errors.push(`Duplicate document ${document.id}`);
    }
    documentIds.add(document.id);
    for (const recordId of document.recordIds) {
      if (!recordIdSet.has(recordId)) {
        errors.push(`Document ${document.id} references unknown record ${recordId}`);
      }
    }
  }

  return errors.sort();
}

export function isArchivePlayer(person: ArchivePerson): boolean {
  return isPlayer(person);
}

/** Current head coach and assistant for a club, then former coaches who held a spell there. */
export function staffForClub(clubId: string): ArchivePerson[] {
  return people
    .filter((person) => person.role === "head_coach" || person.role === "assistant_coach")
    .filter((person) => person.currentClubId === clubId || person.career.some((spell) => spell.clubId === clubId))
    .sort((left, right) => Number(left.retired) - Number(right.retired) || left.name.localeCompare(right.name))
    .map((person) => clone(person));
}

export type NewsWireQuery = {
  clubIds?: string[];
  personIds?: string[];
  /** Inclusive ISO date. Items published after this date are hidden so the wire stays pre-match. */
  asOf?: string;
  limit?: number;
};

/** Deterministic in-process retrieval. Does not require the Foundry IQ index to be re-provisioned. */
export function searchNewsWire(query: NewsWireQuery, source: readonly ArchiveNewsItem[] = newsItems): ArchiveNewsItem[] {
  const clubsWanted = new Set(query.clubIds ?? []);
  const peopleWanted = new Set(query.personIds ?? []);
  if (clubsWanted.size === 0 && peopleWanted.size === 0) return [];
  const asOf = query.asOf ?? "9999-12-31";
  return source
    .filter((item) => item.publishedAt <= asOf)
    .filter((item) => item.clubIds.some((id) => clubsWanted.has(id)) || item.personIds.some((id) => peopleWanted.has(id)))
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt) || left.id.localeCompare(right.id))
    .slice(0, query.limit ?? 8)
    .map((item) => clone(item));
}

/** Keyword fallback over archive documents, including manager profiles and the news wire. */
export function searchArchiveDocuments(queryText: string, limit = 5): ArchiveDocument[] {
  const terms = queryText.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1);
  if (terms.length === 0) return [];
  return archive.documents
    .map((document) => {
      const haystack = `${document.title} ${document.body}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { document, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id))
    .slice(0, limit)
    .map((entry) => clone(entry.document));
}

export function getPlayerProfile(archiveId: string): ArchivePlayerProfile {
  const person = peopleById.get(archiveId);
  if (!person) {
    throw new RangeError(`Unknown archive player: ${archiveId}`);
  }
  const relatedPeople = relativesRaw(archiveId);
  const relatedClubIds = new Set<string>();
  for (const spell of person.career) {
    relatedClubIds.add(spell.clubId);
  }
  if (person.currentClubId) {
    relatedClubIds.add(person.currentClubId);
  }
  for (const relative of relatedPeople) {
    for (const spell of relative.career) {
      relatedClubIds.add(spell.clubId);
    }
  }
  const profileDocuments = archive.documents
    .filter((document) => document.recordIds.includes(archiveId))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    person: clone(person),
    clubs: Object.fromEntries(
      [...relatedClubIds]
        .sort((a, b) => a.localeCompare(b))
        .map((clubId) => [clubId, clone(clubsById.get(clubId))])
        .filter((entry): entry is [string, ArchiveClub] => Boolean(entry[1])),
    ),
    relatives: clone(relatedPeople),
    documents: clone(profileDocuments),
    careerGoals: careerGoalsRaw(archiveId),
  };
}
