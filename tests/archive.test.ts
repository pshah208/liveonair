import test from "node:test";
import assert from "node:assert/strict";

import { careerGoals, getArchive, getPlayerProfile, headToHead, personHistoricGoals, relatives, validateArchive } from "../server/archive/index.js";
import { getFixture } from "../server/fixtures.js";

test("archive validates cleanly and relations are symmetric", () => {
  const archive = getArchive();
  assert.deepEqual(validateArchive(archive), []);

  const peopleById = new Map(archive.people.map((person) => [person.id, person]));
  for (const person of archive.people) {
    for (const relation of person.relations) {
      const opposite = relation.kind === "parent" ? "child" : relation.kind === "child" ? "parent" : "sibling";
      const related = peopleById.get(relation.personId);
      assert.ok(related, `${person.id} relation target exists`);
      assert.ok(related?.relations.some((entry) => entry.personId === person.id && entry.kind === opposite));
    }
  }
});

test("rivergate and northbridge fixture rosters match archive current squads", () => {
  const archive = getArchive();
  const fixture = getFixture("rivergate-comeback");
  const rivergateArchiveNames = archive.people
    .filter((person) => person.currentClubId === fixture.home.archiveClubId && !person.retired)
    .map((person) => person.name)
    .sort();
  const northbridgeArchiveNames = archive.people
    .filter((person) => person.currentClubId === fixture.away.archiveClubId && !person.retired)
    .map((person) => person.name)
    .sort();

  assert.deepEqual(fixture.home.players.map((player) => player.name).sort(), rivergateArchiveNames);
  assert.deepEqual(fixture.away.players.map((player) => player.name).sort(), northbridgeArchiveNames);
  assert.ok(fixture.home.players.every((player) => player.archiveId));
  assert.ok(fixture.away.players.every((player) => player.archiveId));
});

test("archive storyline hooks cover legend relatives, former clubs, milestones and head-to-head", () => {
  const archive = getArchive();
  const opponentByClub = new Map<string, string>([
    ["club-rivergate", "club-northbridge"],
    ["club-northbridge", "club-rivergate"],
  ]);
  const hookPlayers = archive.people.filter((person) => {
    const opponent = person.currentClubId ? opponentByClub.get(person.currentClubId) : undefined;
    if (!opponent) return false;
    return relatives(person.id).some((relative) => {
      return relative.retired && personHistoricGoals(relative.id).some((entry) => entry.match.stage === "final" && (entry.match.homeClubId === opponent || entry.match.awayClubId === opponent));
    });
  });
  assert.ok(hookPlayers.length >= 3);

  const formerClubLinks = archive.people.filter((person) => {
    if (person.currentClubId === "club-rivergate") {
      return person.career.some((spell) => spell.clubId === "club-northbridge");
    }
    if (person.currentClubId === "club-northbridge") {
      return person.career.some((spell) => spell.clubId === "club-rivergate");
    }
    return false;
  });
  assert.ok(formerClubLinks.length >= 2);

  const nearMilestones = archive.people.filter((person) => {
    if (person.retired) return false;
    const goals = careerGoals(person.id);
    const remainder = goals % 50;
    return remainder === 48 || remainder === 49;
  });
  assert.ok(nearMilestones.length >= 1);

  assert.deepEqual(headToHead("club-rivergate", "club-northbridge"), {
    matches: getArchive().matches.filter((match) => {
      return (
        (match.homeClubId === "club-rivergate" && match.awayClubId === "club-northbridge") ||
        (match.homeClubId === "club-northbridge" && match.awayClubId === "club-rivergate")
      );
    }),
    clubAWins: 3,
    clubBWins: 2,
    draws: 1,
  });
});

test("player profile renders derived documents and throws for unknown ids", () => {
  const profile = getPlayerProfile("per-rivergate-leo-arden");
  assert.equal(profile.person.name, "Leo Arden");
  assert.equal(profile.careerGoals, 33);
  assert.ok(profile.relatives.some((person) => person.name === "Cassian Arden"));
  assert.ok(profile.documents.some((document) => document.kind === "player_profile"));

  assert.throws(
    () => getPlayerProfile("per-missing-player"),
    (error: unknown) => error instanceof RangeError,
  );
});
