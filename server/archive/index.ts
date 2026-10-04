import type {
  ArchiveClub,
  ArchiveDocument,
  ArchiveGoal,
  ArchiveMatch,
  ArchivePerson,
  ArchivePlayerProfile,
  ArchiveSnapshot,
} from "../../shared/platform.js";
import { ARCHIVE_VERSION, clubs, matches, people } from "./data.js";

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

function renderClubHistoryDocument(club: ArchiveClub): ArchiveDocument {
  const honoursLine = club.honours
    .map((honour) => `${honour.season} ${honour.competition} ${honour.result.replace("_", " ")}`)
    .join("; ");
  const notablePlayers = people
    .filter((person) => person.currentClubId === club.id)
    .map((person) => person.name)
    .slice(0, 6)
    .join(", ");
  return {
    id: `doc-club-${club.id}`,
    kind: "club_history",
    title: `${club.name} club history`,
    body: `${club.name} (${club.shortName}) of ${club.city}, founded ${club.founded}, play at ${club.stadium}. Honours: ${honoursLine || "none recorded"}. Current archive roster sample: ${notablePlayers}.`,
    recordIds: [club.id, ...club.honours.map((honour) => honour.id), ...club.honours.map((honour) => honour.finalMatchId).filter((value): value is string => Boolean(value))],
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
    ...people.map(renderPlayerProfileDocument),
    ...clubs.map(renderClubHistoryDocument),
    ...matches.map(renderMatchReportDocument),
    ...renderFamilyDocuments(),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

const archive: ArchiveSnapshot = {
  version: ARCHIVE_VERSION,
  clubs: clone(clubs),
  people: clone(people),
  matches: clone(matches),
  documents: buildDocuments(),
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
