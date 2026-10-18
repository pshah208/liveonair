import type {
  ArchiveClub,
  ArchiveMatch,
  ArchivePerson,
  ArchiveRelation,
} from "../../shared/platform.js";

export const ARCHIVE_VERSION = "archive-v1";

export const CLUB_RIVERGATE = "club-rivergate";
export const CLUB_NORTHBRIDGE = "club-northbridge";
export const CLUB_EASTFORD = "club-eastford";
export const CLUB_STONEHAVEN = "club-stonehaven";
export const CLUB_KINGSPORT = "club-kingsport";
export const CLUB_VALE_UNION = "club-vale-union";

function relation(kind: ArchiveRelation["kind"], personId: string): ArchiveRelation {
  return { kind, personId };
}

function currentPerson(input: {
  id: string;
  name: string;
  birthYear: number;
  hometown: string;
  position: string;
  currentClubId: string;
  career: ArchivePerson["career"];
  relations?: ArchiveRelation[];
}): ArchivePerson {
  return {
    id: input.id,
    name: input.name,
    birthYear: input.birthYear,
    hometown: input.hometown,
    position: input.position,
    currentClubId: input.currentClubId,
    career: input.career,
    relations: input.relations ?? [],
    retired: false,
  };
}

function legend(input: {
  id: string;
  name: string;
  birthYear: number;
  hometown: string;
  position: string;
  career: ArchivePerson["career"];
  relations?: ArchiveRelation[];
}): ArchivePerson {
  return {
    id: input.id,
    name: input.name,
    birthYear: input.birthYear,
    hometown: input.hometown,
    position: input.position,
    currentClubId: null,
    career: input.career,
    relations: input.relations ?? [],
    retired: true,
  };
}

export const clubs: ArchiveClub[] = [
  {
    id: CLUB_RIVERGATE,
    name: "Rivergate FC",
    shortName: "RIV",
    city: "Rivergate",
    stadium: "Glass Wharf Ground",
    founded: 1904,
    honours: [
      { id: "hon-riv-2004-founders", competition: "Founders Cup", season: "2003/04", result: "winner", finalMatchId: "match-riv-nba-2004-founders-final" },
      { id: "hon-riv-2008-harbor", competition: "Harbor Shield", season: "2007/08", result: "runner_up", finalMatchId: "match-nba-riv-2008-harbor-final" },
      { id: "hon-riv-2017-crown", competition: "Crown Cup", season: "2016/17", result: "winner", finalMatchId: "match-nba-riv-2017-crown-final" },
      { id: "hon-riv-2019-river", competition: "River Shield", season: "2018/19", result: "winner", finalMatchId: "match-riv-kpa-2019-river-final" },
      { id: "hon-riv-2024-civic", competition: "Civic Cup", season: "2023/24", result: "runner_up", finalMatchId: "match-vun-riv-2024-civic-final" },
    ],
  },
  {
    id: CLUB_NORTHBRIDGE,
    name: "Northbridge Athletic",
    shortName: "NBA",
    city: "Northbridge",
    stadium: "Foundry Park",
    founded: 1911,
    honours: [
      { id: "hon-nba-2004-founders", competition: "Founders Cup", season: "2003/04", result: "runner_up", finalMatchId: "match-riv-nba-2004-founders-final" },
      { id: "hon-nba-2008-harbor", competition: "Harbor Shield", season: "2007/08", result: "winner", finalMatchId: "match-nba-riv-2008-harbor-final" },
      { id: "hon-nba-2012-metro", competition: "Metro Cup", season: "2011/12", result: "winner", finalMatchId: "match-riv-nba-2012-metro-final" },
      { id: "hon-nba-2017-crown", competition: "Crown Cup", season: "2016/17", result: "runner_up", finalMatchId: "match-nba-riv-2017-crown-final" },
      { id: "hon-nba-2024-founders", competition: "Founders Cup", season: "2023/24", result: "winner", finalMatchId: "match-nba-shc-2024-founders-final" },
    ],
  },
  {
    id: CLUB_EASTFORD,
    name: "Eastford Town",
    shortName: "EFT",
    city: "Eastford",
    stadium: "Lantern Field",
    founded: 1923,
    honours: [
      { id: "hon-eft-2015-coastal", competition: "Coastal Cup", season: "2014/15", result: "winner", finalMatchId: "match-eft-shc-2015-coastal-final" },
    ],
  },
  {
    id: CLUB_STONEHAVEN,
    name: "Stonehaven City",
    shortName: "SHC",
    city: "Stonehaven",
    stadium: "Quarry End",
    founded: 1898,
    honours: [
      { id: "hon-shc-2015-coastal", competition: "Coastal Cup", season: "2014/15", result: "runner_up", finalMatchId: "match-eft-shc-2015-coastal-final" },
      { id: "hon-shc-2024-founders", competition: "Founders Cup", season: "2023/24", result: "runner_up", finalMatchId: "match-nba-shc-2024-founders-final" },
    ],
  },
  {
    id: CLUB_KINGSPORT,
    name: "Kingsport Albion",
    shortName: "KPA",
    city: "Kingsport",
    stadium: "Harbor Crown Arena",
    founded: 1930,
    honours: [
      { id: "hon-kpa-2019-river", competition: "River Shield", season: "2018/19", result: "runner_up", finalMatchId: "match-riv-kpa-2019-river-final" },
      { id: "hon-kpa-2021-summit", competition: "Summit Trophy", season: "2020/21", result: "winner", finalMatchId: "match-kpa-vun-2021-summit-final" },
    ],
  },
  {
    id: CLUB_VALE_UNION,
    name: "Vale Union",
    shortName: "VUN",
    city: "Vale Junction",
    stadium: "Union Terrace",
    founded: 1947,
    honours: [
      { id: "hon-vun-2021-summit", competition: "Summit Trophy", season: "2020/21", result: "runner_up", finalMatchId: "match-kpa-vun-2021-summit-final" },
      { id: "hon-vun-2024-civic", competition: "Civic Cup", season: "2023/24", result: "winner", finalMatchId: "match-vun-riv-2024-civic-final" },
    ],
  },
];

const rivergateCurrent: ArchivePerson[] = [
  currentPerson({ id: "per-rivergate-milo-hart", name: "Milo Hart", birthYear: 2000, hometown: "Rivergate", position: "GK", currentClubId: CLUB_RIVERGATE, career: [{ clubId: CLUB_RIVERGATE, fromYear: 2018, toYear: null, appearances: 168, goals: 0 }] }),
  currentPerson({ id: "per-rivergate-theo-vale", name: "Theo Vale", birthYear: 1999, hometown: "Rivergate", position: "RB", currentClubId: CLUB_RIVERGATE, career: [{ clubId: CLUB_RIVERGATE, fromYear: 2017, toYear: null, appearances: 211, goals: 8 }] }),
  currentPerson({ id: "per-rivergate-darian-cross", name: "Darian Cross", birthYear: 1997, hometown: "Hollowmere", position: "CB", currentClubId: CLUB_RIVERGATE, career: [{ clubId: CLUB_STONEHAVEN, fromYear: 2016, toYear: 2020, appearances: 119, goals: 5 }, { clubId: CLUB_RIVERGATE, fromYear: 2021, toYear: null, appearances: 147, goals: 9 }] }),
  currentPerson({ id: "per-rivergate-jonas-mire", name: "Jonas Mire", birthYear: 1996, hometown: "Rivergate", position: "CB", currentClubId: CLUB_RIVERGATE, career: [{ clubId: CLUB_RIVERGATE, fromYear: 2015, toYear: null, appearances: 286, goals: 21 }] }),
  currentPerson({ id: "per-rivergate-elliot-pike", name: "Elliot Pike", birthYear: 2001, hometown: "Rivergate", position: "LB", currentClubId: CLUB_RIVERGATE, career: [{ clubId: CLUB_RIVERGATE, fromYear: 2020, toYear: null, appearances: 132, goals: 6 }] }),
  currentPerson({ id: "per-rivergate-kian-solis", name: "Kian Solis", birthYear: 1998, hometown: "Northbridge", position: "DM", currentClubId: CLUB_RIVERGATE, career: [{ clubId: CLUB_NORTHBRIDGE, fromYear: 2016, toYear: 2021, appearances: 138, goals: 4 }, { clubId: CLUB_RIVERGATE, fromYear: 2022, toYear: null, appearances: 119, goals: 6 }] }),
  currentPerson({ id: "per-rivergate-noah-finch", name: "Noah Finch", birthYear: 2002, hometown: "Northbridge", position: "CM", currentClubId: CLUB_RIVERGATE, career: [{ clubId: CLUB_NORTHBRIDGE, fromYear: 2019, toYear: 2020, appearances: 41, goals: 7 }, { clubId: CLUB_RIVERGATE, fromYear: 2021, toYear: null, appearances: 164, goals: 18 }], relations: [relation("parent", "per-legend-mara-finch")] }),
  currentPerson({ id: "per-rivergate-rafi-calder", name: "Rafi Calder", birthYear: 1999, hometown: "Eastford", position: "AM", currentClubId: CLUB_RIVERGATE, career: [{ clubId: CLUB_EASTFORD, fromYear: 2017, toYear: 2021, appearances: 101, goals: 19 }, { clubId: CLUB_RIVERGATE, fromYear: 2022, toYear: null, appearances: 131, goals: 27 }] }),
  currentPerson({ id: "per-rivergate-leo-arden", name: "Leo Arden", birthYear: 2003, hometown: "Rivergate", position: "RW", currentClubId: CLUB_RIVERGATE, career: [{ clubId: CLUB_RIVERGATE, fromYear: 2021, toYear: null, appearances: 146, goals: 33 }], relations: [relation("parent", "per-legend-cassian-arden")] }),
  currentPerson({ id: "per-rivergate-mateo-quinn", name: "Mateo Quinn", birthYear: 2001, hometown: "Vale Junction", position: "LW", currentClubId: CLUB_RIVERGATE, career: [{ clubId: CLUB_VALE_UNION, fromYear: 2019, toYear: 2022, appearances: 88, goals: 16 }, { clubId: CLUB_RIVERGATE, fromYear: 2023, toYear: null, appearances: 97, goals: 21 }] }),
  currentPerson({ id: "per-rivergate-ilias-rowan", name: "Ilias Rowan", birthYear: 2001, hometown: "Kingsport", position: "ST", currentClubId: CLUB_RIVERGATE, career: [{ clubId: CLUB_KINGSPORT, fromYear: 2018, toYear: 2021, appearances: 93, goals: 24 }, { clubId: CLUB_RIVERGATE, fromYear: 2022, toYear: null, appearances: 128, goals: 25 }], relations: [relation("parent", "per-legend-idris-rowan")] }),
];

const northbridgeCurrent: ArchivePerson[] = [
  currentPerson({ id: "per-northbridge-soren-vale", name: "Soren Vale", birthYear: 1998, hometown: "Northbridge", position: "GK", currentClubId: CLUB_NORTHBRIDGE, career: [{ clubId: CLUB_NORTHBRIDGE, fromYear: 2017, toYear: null, appearances: 229, goals: 0 }] }),
  currentPerson({ id: "per-northbridge-pavel-nix", name: "Pavel Nix", birthYear: 1999, hometown: "Northbridge", position: "RB", currentClubId: CLUB_NORTHBRIDGE, career: [{ clubId: CLUB_NORTHBRIDGE, fromYear: 2018, toYear: null, appearances: 176, goals: 7 }] }),
  currentPerson({ id: "per-northbridge-bram-keane", name: "Bram Keane", birthYear: 1997, hometown: "Rivergate", position: "CB", currentClubId: CLUB_NORTHBRIDGE, career: [{ clubId: CLUB_RIVERGATE, fromYear: 2015, toYear: 2018, appearances: 94, goals: 6 }, { clubId: CLUB_NORTHBRIDGE, fromYear: 2019, toYear: null, appearances: 188, goals: 11 }] }),
  currentPerson({ id: "per-northbridge-oren-fiske", name: "Oren Fiske", birthYear: 1998, hometown: "Rivergate", position: "CB", currentClubId: CLUB_NORTHBRIDGE, career: [{ clubId: CLUB_NORTHBRIDGE, fromYear: 2017, toYear: null, appearances: 205, goals: 9 }], relations: [relation("parent", "per-legend-elias-fiske")] }),
  currentPerson({ id: "per-northbridge-galen-mott", name: "Galen Mott", birthYear: 2000, hometown: "Northbridge", position: "LB", currentClubId: CLUB_NORTHBRIDGE, career: [{ clubId: CLUB_NORTHBRIDGE, fromYear: 2019, toYear: null, appearances: 141, goals: 4 }] }),
  currentPerson({ id: "per-northbridge-tomas-reed", name: "Tomas Reed", birthYear: 1996, hometown: "Stonehaven", position: "DM", currentClubId: CLUB_NORTHBRIDGE, career: [{ clubId: CLUB_STONEHAVEN, fromYear: 2014, toYear: 2018, appearances: 121, goals: 8 }, { clubId: CLUB_NORTHBRIDGE, fromYear: 2019, toYear: null, appearances: 172, goals: 10 }] }),
  currentPerson({ id: "per-northbridge-jude-asher", name: "Jude Asher", birthYear: 2002, hometown: "Northbridge", position: "CM", currentClubId: CLUB_NORTHBRIDGE, career: [{ clubId: CLUB_NORTHBRIDGE, fromYear: 2020, toYear: null, appearances: 119, goals: 15 }] }),
  currentPerson({ id: "per-northbridge-caleb-frost", name: "Caleb Frost", birthYear: 1998, hometown: "Rivergate", position: "AM", currentClubId: CLUB_NORTHBRIDGE, career: [{ clubId: CLUB_RIVERGATE, fromYear: 2018, toYear: 2022, appearances: 111, goals: 12 }, { clubId: CLUB_NORTHBRIDGE, fromYear: 2023, toYear: null, appearances: 96, goals: 15 }] }),
  currentPerson({ id: "per-northbridge-ronan-bly", name: "Ronan Bly", birthYear: 2001, hometown: "Northbridge", position: "RW", currentClubId: CLUB_NORTHBRIDGE, career: [{ clubId: CLUB_NORTHBRIDGE, fromYear: 2020, toYear: null, appearances: 139, goals: 31 }], relations: [relation("parent", "per-legend-garrick-bly")] }),
  currentPerson({ id: "per-northbridge-silas-venn", name: "Silas Venn", birthYear: 2001, hometown: "Vale Junction", position: "LW", currentClubId: CLUB_NORTHBRIDGE, career: [{ clubId: CLUB_VALE_UNION, fromYear: 2019, toYear: 2022, appearances: 77, goals: 11 }, { clubId: CLUB_NORTHBRIDGE, fromYear: 2023, toYear: null, appearances: 91, goals: 17 }] }),
  currentPerson({ id: "per-northbridge-nico-hale", name: "Nico Hale", birthYear: 2000, hometown: "Northbridge", position: "ST", currentClubId: CLUB_NORTHBRIDGE, career: [{ clubId: CLUB_NORTHBRIDGE, fromYear: 2018, toYear: null, appearances: 183, goals: 48 }] }),
];

const eastfordCurrent: ArchivePerson[] = [
  currentPerson({ id: "per-eastford-orin-lake", name: "Orin Lake", birthYear: 1999, hometown: "Eastford", position: "GK", currentClubId: CLUB_EASTFORD, career: [{ clubId: CLUB_EASTFORD, fromYear: 2018, toYear: null, appearances: 162, goals: 0 }] }),
  currentPerson({ id: "per-eastford-cian-ember", name: "Cian Ember", birthYear: 2001, hometown: "Eastford", position: "RB", currentClubId: CLUB_EASTFORD, career: [{ clubId: CLUB_EASTFORD, fromYear: 2019, toYear: null, appearances: 121, goals: 5 }] }),
  currentPerson({ id: "per-eastford-toren-ash", name: "Toren Ash", birthYear: 1997, hometown: "Eastford", position: "CB", currentClubId: CLUB_EASTFORD, career: [{ clubId: CLUB_EASTFORD, fromYear: 2016, toYear: null, appearances: 227, goals: 14 }] }),
  currentPerson({ id: "per-eastford-silas-crowe", name: "Silas Crowe", birthYear: 1998, hometown: "Eastford", position: "CB", currentClubId: CLUB_EASTFORD, career: [{ clubId: CLUB_EASTFORD, fromYear: 2017, toYear: null, appearances: 196, goals: 9 }] }),
  currentPerson({ id: "per-eastford-lyle-fenn", name: "Lyle Fenn", birthYear: 2000, hometown: "Eastford", position: "LB", currentClubId: CLUB_EASTFORD, career: [{ clubId: CLUB_EASTFORD, fromYear: 2019, toYear: null, appearances: 149, goals: 8 }] }),
  currentPerson({ id: "per-eastford-samir-dane", name: "Samir Dane", birthYear: 1998, hometown: "Harbor Wick", position: "DM", currentClubId: CLUB_EASTFORD, career: [{ clubId: CLUB_STONEHAVEN, fromYear: 2016, toYear: 2020, appearances: 104, goals: 7 }, { clubId: CLUB_EASTFORD, fromYear: 2021, toYear: null, appearances: 117, goals: 10 }] }),
  currentPerson({ id: "per-eastford-owen-mercer", name: "Owen Mercer", birthYear: 2001, hometown: "Eastford", position: "CM", currentClubId: CLUB_EASTFORD, career: [{ clubId: CLUB_EASTFORD, fromYear: 2020, toYear: null, appearances: 109, goals: 13 }] }),
  currentPerson({ id: "per-eastford-reese-marlow", name: "Reese Marlow", birthYear: 1999, hometown: "Eastford", position: "AM", currentClubId: CLUB_EASTFORD, career: [{ clubId: CLUB_EASTFORD, fromYear: 2018, toYear: null, appearances: 152, goals: 28 }] }),
  currentPerson({ id: "per-eastford-jory-sable", name: "Jory Sable", birthYear: 2002, hometown: "Eastford", position: "RW", currentClubId: CLUB_EASTFORD, career: [{ clubId: CLUB_EASTFORD, fromYear: 2021, toYear: null, appearances: 91, goals: 19 }] }),
  currentPerson({ id: "per-eastford-naren-fox", name: "Naren Fox", birthYear: 2001, hometown: "Eastford", position: "LW", currentClubId: CLUB_EASTFORD, career: [{ clubId: CLUB_EASTFORD, fromYear: 2020, toYear: null, appearances: 97, goals: 17 }] }),
  currentPerson({ id: "per-eastford-casper-holt", name: "Casper Holt", birthYear: 1998, hometown: "Eastford", position: "ST", currentClubId: CLUB_EASTFORD, career: [{ clubId: CLUB_EASTFORD, fromYear: 2017, toYear: null, appearances: 181, goals: 52 }] }),
];

const stonehavenCurrent: ArchivePerson[] = [
  currentPerson({ id: "per-stonehaven-roan-cairn", name: "Roan Cairn", birthYear: 1999, hometown: "Stonehaven", position: "GK", currentClubId: CLUB_STONEHAVEN, career: [{ clubId: CLUB_STONEHAVEN, fromYear: 2018, toYear: null, appearances: 175, goals: 0 }] }),
  currentPerson({ id: "per-stonehaven-finn-dacre", name: "Finn Dacre", birthYear: 2000, hometown: "Stonehaven", position: "RB", currentClubId: CLUB_STONEHAVEN, career: [{ clubId: CLUB_STONEHAVEN, fromYear: 2019, toYear: null, appearances: 133, goals: 6 }] }),
  currentPerson({ id: "per-stonehaven-isaac-durr", name: "Isaac Durr", birthYear: 1997, hometown: "Stonehaven", position: "CB", currentClubId: CLUB_STONEHAVEN, career: [{ clubId: CLUB_STONEHAVEN, fromYear: 2016, toYear: null, appearances: 214, goals: 12 }] }),
  currentPerson({ id: "per-stonehaven-bren-wyatt", name: "Bren Wyatt", birthYear: 1998, hometown: "Stonehaven", position: "CB", currentClubId: CLUB_STONEHAVEN, career: [{ clubId: CLUB_STONEHAVEN, fromYear: 2017, toYear: null, appearances: 204, goals: 11 }] }),
  currentPerson({ id: "per-stonehaven-dane-quarry", name: "Dane Quarry", birthYear: 2001, hometown: "Stonehaven", position: "LB", currentClubId: CLUB_STONEHAVEN, career: [{ clubId: CLUB_STONEHAVEN, fromYear: 2020, toYear: null, appearances: 112, goals: 5 }] }),
  currentPerson({ id: "per-stonehaven-marek-flint", name: "Marek Flint", birthYear: 1998, hometown: "Stonehaven", position: "DM", currentClubId: CLUB_STONEHAVEN, career: [{ clubId: CLUB_STONEHAVEN, fromYear: 2018, toYear: null, appearances: 165, goals: 10 }] }),
  currentPerson({ id: "per-stonehaven-ellis-penn", name: "Ellis Penn", birthYear: 2002, hometown: "Stonehaven", position: "CM", currentClubId: CLUB_STONEHAVEN, career: [{ clubId: CLUB_STONEHAVEN, fromYear: 2021, toYear: null, appearances: 84, goals: 9 }] }),
  currentPerson({ id: "per-stonehaven-kellan-rune", name: "Kellan Rune", birthYear: 1999, hometown: "Stonehaven", position: "AM", currentClubId: CLUB_STONEHAVEN, career: [{ clubId: CLUB_STONEHAVEN, fromYear: 2018, toYear: null, appearances: 157, goals: 24 }] }),
  currentPerson({ id: "per-stonehaven-jasper-tilt", name: "Jasper Tilt", birthYear: 2000, hometown: "Stonehaven", position: "RW", currentClubId: CLUB_STONEHAVEN, career: [{ clubId: CLUB_STONEHAVEN, fromYear: 2019, toYear: null, appearances: 129, goals: 18 }] }),
  currentPerson({ id: "per-stonehaven-ren-lark", name: "Ren Lark", birthYear: 2001, hometown: "Stonehaven", position: "LW", currentClubId: CLUB_STONEHAVEN, career: [{ clubId: CLUB_STONEHAVEN, fromYear: 2020, toYear: null, appearances: 106, goals: 20 }] }),
  currentPerson({ id: "per-stonehaven-tavian-brook", name: "Tavian Brook", birthYear: 1998, hometown: "Stonehaven", position: "ST", currentClubId: CLUB_STONEHAVEN, career: [{ clubId: CLUB_STONEHAVEN, fromYear: 2017, toYear: null, appearances: 187, goals: 57 }] }),
];

const kingsportCurrent: ArchivePerson[] = [
  currentPerson({ id: "per-kingsport-elan-ward", name: "Elan Ward", birthYear: 2000, hometown: "Kingsport", position: "GK", currentClubId: CLUB_KINGSPORT, career: [{ clubId: CLUB_KINGSPORT, fromYear: 2019, toYear: null, appearances: 148, goals: 0 }] }),
  currentPerson({ id: "per-kingsport-heath-rowe", name: "Heath Rowe", birthYear: 1999, hometown: "Kingsport", position: "RB", currentClubId: CLUB_KINGSPORT, career: [{ clubId: CLUB_KINGSPORT, fromYear: 2018, toYear: null, appearances: 171, goals: 7 }] }),
  currentPerson({ id: "per-kingsport-jalen-ford", name: "Jalen Ford", birthYear: 1998, hometown: "Kingsport", position: "CB", currentClubId: CLUB_KINGSPORT, career: [{ clubId: CLUB_KINGSPORT, fromYear: 2017, toYear: null, appearances: 198, goals: 10 }] }),
  currentPerson({ id: "per-kingsport-evan-rusk", name: "Evan Rusk", birthYear: 1997, hometown: "Kingsport", position: "CB", currentClubId: CLUB_KINGSPORT, career: [{ clubId: CLUB_KINGSPORT, fromYear: 2016, toYear: null, appearances: 221, goals: 12 }] }),
  currentPerson({ id: "per-kingsport-lyric-moss", name: "Lyric Moss", birthYear: 2001, hometown: "Kingsport", position: "LB", currentClubId: CLUB_KINGSPORT, career: [{ clubId: CLUB_KINGSPORT, fromYear: 2020, toYear: null, appearances: 101, goals: 4 }] }),
  currentPerson({ id: "per-kingsport-cade-nolan", name: "Cade Nolan", birthYear: 1998, hometown: "Kingsport", position: "DM", currentClubId: CLUB_KINGSPORT, career: [{ clubId: CLUB_KINGSPORT, fromYear: 2017, toYear: null, appearances: 176, goals: 9 }] }),
  currentPerson({ id: "per-kingsport-oren-quill", name: "Oren Quill", birthYear: 2002, hometown: "Kingsport", position: "CM", currentClubId: CLUB_KINGSPORT, career: [{ clubId: CLUB_KINGSPORT, fromYear: 2021, toYear: null, appearances: 88, goals: 12 }] }),
  currentPerson({ id: "per-kingsport-sol-merrin", name: "Sol Merrin", birthYear: 1999, hometown: "Kingsport", position: "AM", currentClubId: CLUB_KINGSPORT, career: [{ clubId: CLUB_KINGSPORT, fromYear: 2018, toYear: null, appearances: 147, goals: 26 }] }),
  currentPerson({ id: "per-kingsport-kael-thorne", name: "Kael Thorne", birthYear: 2001, hometown: "Kingsport", position: "RW", currentClubId: CLUB_KINGSPORT, career: [{ clubId: CLUB_KINGSPORT, fromYear: 2020, toYear: null, appearances: 109, goals: 18 }] }),
  currentPerson({ id: "per-kingsport-nico-vale", name: "Nico Vale", birthYear: 2000, hometown: "Kingsport", position: "LW", currentClubId: CLUB_KINGSPORT, career: [{ clubId: CLUB_KINGSPORT, fromYear: 2019, toYear: null, appearances: 122, goals: 20 }] }),
  currentPerson({ id: "per-kingsport-soren-bright", name: "Soren Bright", birthYear: 1999, hometown: "Kingsport", position: "ST", currentClubId: CLUB_KINGSPORT, career: [{ clubId: CLUB_KINGSPORT, fromYear: 2018, toYear: null, appearances: 164, goals: 45 }] }),
];

const valeUnionCurrent: ArchivePerson[] = [
  currentPerson({ id: "per-vale-union-aron-gale", name: "Aron Gale", birthYear: 2000, hometown: "Vale Junction", position: "GK", currentClubId: CLUB_VALE_UNION, career: [{ clubId: CLUB_VALE_UNION, fromYear: 2019, toYear: null, appearances: 144, goals: 0 }] }),
  currentPerson({ id: "per-vale-union-dario-kite", name: "Dario Kite", birthYear: 2001, hometown: "Vale Junction", position: "RB", currentClubId: CLUB_VALE_UNION, career: [{ clubId: CLUB_VALE_UNION, fromYear: 2020, toYear: null, appearances: 103, goals: 5 }] }),
  currentPerson({ id: "per-vale-union-pierce-north", name: "Pierce North", birthYear: 1998, hometown: "Vale Junction", position: "CB", currentClubId: CLUB_VALE_UNION, career: [{ clubId: CLUB_VALE_UNION, fromYear: 2017, toYear: null, appearances: 186, goals: 9 }] }),
  currentPerson({ id: "per-vale-union-hugo-rell", name: "Hugo Rell", birthYear: 1997, hometown: "Vale Junction", position: "CB", currentClubId: CLUB_VALE_UNION, career: [{ clubId: CLUB_VALE_UNION, fromYear: 2016, toYear: null, appearances: 209, goals: 11 }] }),
  currentPerson({ id: "per-vale-union-lucan-reef", name: "Lucan Reef", birthYear: 2001, hometown: "Vale Junction", position: "LB", currentClubId: CLUB_VALE_UNION, career: [{ clubId: CLUB_VALE_UNION, fromYear: 2020, toYear: null, appearances: 111, goals: 6 }] }),
  currentPerson({ id: "per-vale-union-emmet-yarrow", name: "Emmet Yarrow", birthYear: 1999, hometown: "Vale Junction", position: "DM", currentClubId: CLUB_VALE_UNION, career: [{ clubId: CLUB_VALE_UNION, fromYear: 2018, toYear: null, appearances: 153, goals: 8 }] }),
  currentPerson({ id: "per-vale-union-connor-slate", name: "Connor Slate", birthYear: 2002, hometown: "Vale Junction", position: "CM", currentClubId: CLUB_VALE_UNION, career: [{ clubId: CLUB_VALE_UNION, fromYear: 2021, toYear: null, appearances: 90, goals: 11 }] }),
  currentPerson({ id: "per-vale-union-marco-ellis", name: "Marco Ellis", birthYear: 1999, hometown: "Vale Junction", position: "AM", currentClubId: CLUB_VALE_UNION, career: [{ clubId: CLUB_VALE_UNION, fromYear: 2018, toYear: null, appearances: 149, goals: 29 }] }),
  currentPerson({ id: "per-vale-union-quentin-faye", name: "Quentin Faye", birthYear: 2001, hometown: "Vale Junction", position: "RW", currentClubId: CLUB_VALE_UNION, career: [{ clubId: CLUB_VALE_UNION, fromYear: 2020, toYear: null, appearances: 106, goals: 17 }] }),
  currentPerson({ id: "per-vale-union-rio-sutton", name: "Rio Sutton", birthYear: 2000, hometown: "Vale Junction", position: "LW", currentClubId: CLUB_VALE_UNION, career: [{ clubId: CLUB_VALE_UNION, fromYear: 2019, toYear: null, appearances: 126, goals: 22 }] }),
  currentPerson({ id: "per-vale-union-marek-hale", name: "Marek Hale", birthYear: 1998, hometown: "Vale Junction", position: "ST", currentClubId: CLUB_VALE_UNION, career: [{ clubId: CLUB_VALE_UNION, fromYear: 2017, toYear: null, appearances: 181, goals: 54 }] }),
];

const legends: ArchivePerson[] = [
  legend({ id: "per-legend-cassian-arden", name: "Cassian Arden", birthYear: 1978, hometown: "Rivergate", position: "FW", career: [{ clubId: CLUB_RIVERGATE, fromYear: 1996, toYear: 2008, appearances: 341, goals: 146 }], relations: [relation("child", "per-rivergate-leo-arden")] }),
  legend({ id: "per-legend-mara-finch", name: "Mara Finch", birthYear: 1979, hometown: "Northbridge", position: "AM", career: [{ clubId: CLUB_NORTHBRIDGE, fromYear: 1998, toYear: 2010, appearances: 318, goals: 102 }], relations: [relation("child", "per-rivergate-noah-finch")] }),
  legend({ id: "per-legend-garrick-bly", name: "Garrick Bly", birthYear: 1977, hometown: "Northbridge", position: "ST", career: [{ clubId: CLUB_NORTHBRIDGE, fromYear: 1997, toYear: 2011, appearances: 366, goals: 171 }], relations: [relation("child", "per-northbridge-ronan-bly")] }),
  legend({ id: "per-legend-elias-fiske", name: "Elias Fiske", birthYear: 1976, hometown: "Rivergate", position: "CB", career: [{ clubId: CLUB_RIVERGATE, fromYear: 1995, toYear: 2009, appearances: 392, goals: 39 }], relations: [relation("child", "per-northbridge-oren-fiske")] }),
  legend({ id: "per-legend-idris-rowan", name: "Idris Rowan", birthYear: 1975, hometown: "Kingsport", position: "ST", career: [{ clubId: CLUB_KINGSPORT, fromYear: 1994, toYear: 2005, appearances: 307, goals: 128 }, { clubId: CLUB_RIVERGATE, fromYear: 2006, toYear: 2018, appearances: 281, goals: 97 }], relations: [relation("child", "per-rivergate-ilias-rowan")] }),
  legend({ id: "per-legend-tomas-vale", name: "Tomas Vale", birthYear: 1972, hometown: "Rivergate", position: "RB", career: [{ clubId: CLUB_RIVERGATE, fromYear: 1991, toYear: 2005, appearances: 402, goals: 23 }] }),
  legend({ id: "per-legend-sera-quinn", name: "Sera Quinn", birthYear: 1981, hometown: "Vale Junction", position: "LW", career: [{ clubId: CLUB_VALE_UNION, fromYear: 1999, toYear: 2014, appearances: 355, goals: 119 }] }),
  legend({ id: "per-legend-dorian-cross", name: "Dorian Cross", birthYear: 1974, hometown: "Hollowmere", position: "CB", career: [{ clubId: CLUB_STONEHAVEN, fromYear: 1993, toYear: 2007, appearances: 388, goals: 21 }] }),
  legend({ id: "per-legend-nadia-pike", name: "Nadia Pike", birthYear: 1978, hometown: "Rivergate", position: "LB", career: [{ clubId: CLUB_RIVERGATE, fromYear: 1997, toYear: 2011, appearances: 344, goals: 15 }] }),
  legend({ id: "per-legend-orson-calder", name: "Orson Calder", birthYear: 1976, hometown: "Eastford", position: "AM", career: [{ clubId: CLUB_EASTFORD, fromYear: 1995, toYear: 2010, appearances: 333, goals: 88 }] }),
  legend({ id: "per-legend-soren-dray", name: "Soren Dray", birthYear: 1977, hometown: "Northbridge", position: "FW", career: [{ clubId: CLUB_NORTHBRIDGE, fromYear: 1996, toYear: 2009, appearances: 312, goals: 114 }] }),
  legend({ id: "per-legend-leon-varro", name: "Leon Varro", birthYear: 1974, hometown: "Rivergate", position: "FW", career: [{ clubId: CLUB_RIVERGATE, fromYear: 1994, toYear: 2008, appearances: 298, goals: 121 }] }),
  legend({ id: "per-legend-theo-maren", name: "Theo Maren", birthYear: 1980, hometown: "Rivergate", position: "AM", career: [{ clubId: CLUB_RIVERGATE, fromYear: 1999, toYear: 2015, appearances: 359, goals: 93 }] }),
  legend({ id: "per-legend-calder-wynn", name: "Calder Wynn", birthYear: 1982, hometown: "Northbridge", position: "AM", career: [{ clubId: CLUB_NORTHBRIDGE, fromYear: 2001, toYear: 2016, appearances: 321, goals: 84 }] }),
  legend({ id: "per-legend-maeve-quarry", name: "Maeve Quarry", birthYear: 1976, hometown: "Stonehaven", position: "ST", career: [{ clubId: CLUB_STONEHAVEN, fromYear: 1995, toYear: 2010, appearances: 301, goals: 116 }] }),
  legend({ id: "per-legend-oscar-flint", name: "Oscar Flint", birthYear: 1973, hometown: "Stonehaven", position: "CB", career: [{ clubId: CLUB_STONEHAVEN, fromYear: 1992, toYear: 2008, appearances: 405, goals: 29 }] }),
  legend({ id: "per-legend-emlyn-ward", name: "Emlyn Ward", birthYear: 1978, hometown: "Kingsport", position: "GK", career: [{ clubId: CLUB_KINGSPORT, fromYear: 1998, toYear: 2013, appearances: 377, goals: 0 }] }),
  legend({ id: "per-legend-harlan-moss", name: "Harlan Moss", birthYear: 1975, hometown: "Kingsport", position: "LW", career: [{ clubId: CLUB_KINGSPORT, fromYear: 1994, toYear: 2009, appearances: 318, goals: 109 }] }),
  legend({ id: "per-legend-lydia-reef", name: "Lydia Reef", birthYear: 1979, hometown: "Vale Junction", position: "RB", career: [{ clubId: CLUB_VALE_UNION, fromYear: 1998, toYear: 2012, appearances: 336, goals: 18 }] }),
  legend({ id: "per-legend-victor-yarrow", name: "Victor Yarrow", birthYear: 1974, hometown: "Vale Junction", position: "ST", career: [{ clubId: CLUB_VALE_UNION, fromYear: 1993, toYear: 2008, appearances: 327, goals: 124 }] }),
];

function coach(input: {
  id: string;
  name: string;
  birthYear: number;
  hometown: string;
  role: "head_coach" | "assistant_coach";
  currentClubId: string | null;
  retired?: boolean;
  career: ArchivePerson["career"];
  relations?: ArchiveRelation[];
  tenureNotes: string;
  staffRecord: NonNullable<ArchivePerson["staffRecord"]>;
  notableMatchIds?: string[];
}): ArchivePerson {
  return {
    id: input.id,
    name: input.name,
    birthYear: input.birthYear,
    hometown: input.hometown,
    position: input.role === "head_coach" ? "Head coach" : "Assistant coach",
    currentClubId: input.currentClubId,
    career: input.career,
    relations: input.relations ?? [],
    retired: input.retired ?? false,
    role: input.role,
    realWorld: false,
    tenureNotes: input.tenureNotes,
    staffRecord: input.staffRecord,
    notableMatchIds: input.notableMatchIds,
  };
}

const spell = (clubId: string, fromYear: number, toYear: number | null): ArchivePerson["career"][number] => ({
  clubId, fromYear, toYear, appearances: 0, goals: 0,
});

/** Synthetic head coaches and assistants. Not on matchday squads; linked to clubs via currentClubId. */
const staff: ArchivePerson[] = [
  coach({
    id: "per-coach-rivergate-helena-voss",
    name: "Helena Voss",
    birthYear: 1974,
    hometown: "Rivergate",
    role: "head_coach",
    currentClubId: CLUB_RIVERGATE,
    career: [spell(CLUB_EASTFORD, 2014, 2018), spell(CLUB_RIVERGATE, 2019, null)],
    tenureNotes: "Helena Voss has managed Rivergate FC since 2019 after four seasons at Eastford Town. She was in the dugout for the 2019 River Shield final win over Kingsport Albion and the 2024 Civic Cup final loss to Vale Union. Record at Rivergate: 214 matches, 118 wins, 46 draws, 50 losses.",
    staffRecord: { matches: 214, wins: 118, draws: 46, losses: 50 },
    notableMatchIds: ["match-riv-kpa-2019-river-final", "match-vun-riv-2024-civic-final"],
  }),
  coach({
    id: "per-coach-rivergate-marcus-pell",
    name: "Marcus Pell",
    birthYear: 1981,
    hometown: "Hollowmere",
    role: "assistant_coach",
    currentClubId: CLUB_RIVERGATE,
    career: [spell(CLUB_STONEHAVEN, 2016, 2020), spell(CLUB_RIVERGATE, 2021, null)],
    relations: [relation("sibling", "per-coach-northbridge-lila-pell")],
    tenureNotes: "Marcus Pell joined Helena Voss's staff in 2021. His sister Lila Pell is assistant coach at Northbridge Athletic, so the Rivergate-Northbridge meetings are a family occasion as well as a rivalry.",
    staffRecord: { matches: 148, wins: 79, draws: 31, losses: 38 },
  }),
  coach({
    id: "per-coach-rivergate-otto-lang",
    name: "Otto Lang",
    birthYear: 1962,
    hometown: "Rivergate",
    role: "head_coach",
    currentClubId: null,
    retired: true,
    career: [spell(CLUB_RIVERGATE, 2008, 2018)],
    tenureNotes: "Otto Lang managed Rivergate FC from 2008 to 2018, including the 2017 Crown Cup final win over Northbridge Athletic. He left after a winless run of 8 league matches.",
    staffRecord: { matches: 412, wins: 201, draws: 96, losses: 115 },
    notableMatchIds: ["match-nba-riv-2017-crown-final"],
  }),
  coach({
    id: "per-coach-northbridge-idris-okonkwo",
    name: "Idris Okonkwo",
    birthYear: 1976,
    hometown: "Northbridge",
    role: "head_coach",
    currentClubId: CLUB_NORTHBRIDGE,
    career: [spell(CLUB_KINGSPORT, 2015, 2019), spell(CLUB_NORTHBRIDGE, 2020, null)],
    tenureNotes: "Idris Okonkwo has managed Northbridge Athletic since 2020. He was in the dugout for the 2024 Founders Cup final win over Stonehaven City. Record at Northbridge: 198 matches, 109 wins, 41 draws, 48 losses.",
    staffRecord: { matches: 198, wins: 109, draws: 41, losses: 48 },
    notableMatchIds: ["match-nba-shc-2024-founders-final"],
  }),
  coach({
    id: "per-coach-northbridge-lila-pell",
    name: "Lila Pell",
    birthYear: 1983,
    hometown: "Hollowmere",
    role: "assistant_coach",
    currentClubId: CLUB_NORTHBRIDGE,
    career: [spell(CLUB_NORTHBRIDGE, 2018, null)],
    relations: [relation("sibling", "per-coach-rivergate-marcus-pell")],
    tenureNotes: "Lila Pell has been assistant coach at Northbridge Athletic since 2018. Her brother Marcus Pell is assistant coach at Rivergate FC.",
    staffRecord: { matches: 246, wins: 131, draws: 52, losses: 63 },
  }),
  coach({
    id: "per-coach-northbridge-prior-keel",
    name: "Prior Keel",
    birthYear: 1960,
    hometown: "Northbridge",
    role: "head_coach",
    currentClubId: null,
    retired: true,
    career: [spell(CLUB_NORTHBRIDGE, 2006, 2019)],
    tenureNotes: "Prior Keel managed Northbridge Athletic from 2006 to 2019 and led them to the 2008 Harbor Shield and the 2012 Metro Cup, both against Rivergate FC.",
    staffRecord: { matches: 520, wins: 268, draws: 112, losses: 140 },
    notableMatchIds: ["match-nba-riv-2008-harbor-final", "match-riv-nba-2012-metro-final"],
  }),
  coach({
    id: "per-coach-eastford-naomi-kerr",
    name: "Naomi Kerr",
    birthYear: 1979,
    hometown: "Eastford",
    role: "head_coach",
    currentClubId: CLUB_EASTFORD,
    career: [spell(CLUB_VALE_UNION, 2016, 2020), spell(CLUB_EASTFORD, 2021, null)],
    tenureNotes: "Naomi Kerr has managed Eastford Town since 2021. Record: 156 matches, 64 wins, 40 draws, 52 losses. She has spoken about needing a result against the top six.",
    staffRecord: { matches: 156, wins: 64, draws: 40, losses: 52 },
  }),
  coach({
    id: "per-coach-eastford-tomas-abebe",
    name: "Tomas Abebe",
    birthYear: 1985,
    hometown: "Eastford",
    role: "assistant_coach",
    currentClubId: CLUB_EASTFORD,
    career: [spell(CLUB_EASTFORD, 2019, null)],
    tenureNotes: "Tomas Abebe has been assistant coach at Eastford Town since 2019, through the end of the previous head coach's spell and Naomi Kerr's appointment.",
    staffRecord: { matches: 210, wins: 88, draws: 54, losses: 68 },
  }),
  coach({
    id: "per-coach-stonehaven-edgar-quill",
    name: "Edgar Quill",
    birthYear: 1971,
    hometown: "Stonehaven",
    role: "head_coach",
    currentClubId: CLUB_STONEHAVEN,
    career: [spell(CLUB_STONEHAVEN, 2017, null)],
    tenureNotes: "Edgar Quill has managed Stonehaven City since 2017. He was in the dugout for the 2024 Founders Cup final loss to Northbridge Athletic. Record: 302 matches, 121 wins, 74 draws, 107 losses.",
    staffRecord: { matches: 302, wins: 121, draws: 74, losses: 107 },
    notableMatchIds: ["match-nba-shc-2024-founders-final"],
  }),
  coach({
    id: "per-coach-stonehaven-sable-nguyen",
    name: "Sable Nguyen",
    birthYear: 1986,
    hometown: "Stonehaven",
    role: "assistant_coach",
    currentClubId: CLUB_STONEHAVEN,
    career: [spell(CLUB_EASTFORD, 2015, 2019), spell(CLUB_STONEHAVEN, 2020, null)],
    tenureNotes: "Sable Nguyen joined Edgar Quill's staff in 2020 after four seasons at Eastford Town.",
    staffRecord: { matches: 188, wins: 72, draws: 49, losses: 67 },
  }),
  coach({
    id: "per-coach-kingsport-freya-moss",
    name: "Freya Moss",
    birthYear: 1978,
    hometown: "Kingsport",
    role: "head_coach",
    currentClubId: CLUB_KINGSPORT,
    career: [spell(CLUB_KINGSPORT, 2018, null)],
    tenureNotes: "Freya Moss has managed Kingsport Albion since 2018, including the 2019 River Shield final loss to Rivergate FC and the 2021 Summit Trophy win over Vale Union. Record: 276 matches, 132 wins, 61 draws, 83 losses.",
    staffRecord: { matches: 276, wins: 132, draws: 61, losses: 83 },
    notableMatchIds: ["match-riv-kpa-2019-river-final", "match-kpa-vun-2021-summit-final"],
  }),
  coach({
    id: "per-coach-kingsport-julian-adeyemi",
    name: "Julian Adeyemi",
    birthYear: 1984,
    hometown: "Kingsport",
    role: "assistant_coach",
    currentClubId: CLUB_KINGSPORT,
    career: [spell(CLUB_KINGSPORT, 2019, null)],
    tenureNotes: "Julian Adeyemi has been assistant coach at Kingsport Albion since 2019, working under Freya Moss.",
    staffRecord: { matches: 230, wins: 108, draws: 52, losses: 70 },
  }),
  coach({
    id: "per-coach-vale-conrad-briggs",
    name: "Conrad Briggs",
    birthYear: 1973,
    hometown: "Vale Junction",
    role: "head_coach",
    currentClubId: CLUB_VALE_UNION,
    career: [spell(CLUB_STONEHAVEN, 2012, 2017), spell(CLUB_VALE_UNION, 2018, null)],
    tenureNotes: "Conrad Briggs has managed Vale Union since 2018. He won the 2024 Civic Cup final against Rivergate FC and lost the 2021 Summit Trophy final to Kingsport Albion. Record at Vale Union: 268 matches, 119 wins, 63 draws, 86 losses.",
    staffRecord: { matches: 268, wins: 119, draws: 63, losses: 86 },
    notableMatchIds: ["match-vun-riv-2024-civic-final", "match-kpa-vun-2021-summit-final"],
  }),
  coach({
    id: "per-coach-vale-anika-shah",
    name: "Anika Shah",
    birthYear: 1982,
    hometown: "Vale Junction",
    role: "assistant_coach",
    currentClubId: CLUB_VALE_UNION,
    career: [spell(CLUB_VALE_UNION, 2018, null)],
    tenureNotes: "Anika Shah has been assistant coach at Vale Union since Conrad Briggs arrived in 2018.",
    staffRecord: { matches: 268, wins: 119, draws: 63, losses: 86 },
  }),
];

export const people: ArchivePerson[] = [
  ...rivergateCurrent,
  ...northbridgeCurrent,
  ...eastfordCurrent,
  ...stonehavenCurrent,
  ...kingsportCurrent,
  ...valeUnionCurrent,
  ...legends,
  ...staff,
];

export const matches: ArchiveMatch[] = [
  {
    id: "match-riv-nba-2004-founders-final",
    date: "2004-05-22",
    season: "2003/04",
    competition: "Founders Cup",
    stage: "final",
    homeClubId: CLUB_RIVERGATE,
    awayClubId: CLUB_NORTHBRIDGE,
    homeScore: 2,
    awayScore: 1,
    venue: "Meridian Bowl",
    goals: [
      { personId: "per-legend-cassian-arden", clubId: CLUB_RIVERGATE, minute: 18 },
      { personId: "per-legend-cassian-arden", clubId: CLUB_RIVERGATE, minute: 31 },
      { personId: "per-legend-garrick-bly", clubId: CLUB_NORTHBRIDGE, minute: 77 },
    ],
  },
  {
    id: "match-nba-riv-2008-harbor-final",
    date: "2008-05-24",
    season: "2007/08",
    competition: "Harbor Shield",
    stage: "final",
    homeClubId: CLUB_NORTHBRIDGE,
    awayClubId: CLUB_RIVERGATE,
    homeScore: 3,
    awayScore: 2,
    venue: "Mariner Dome",
    goals: [
      { personId: "per-legend-leon-varro", clubId: CLUB_RIVERGATE, minute: 11 },
      { personId: "per-legend-mara-finch", clubId: CLUB_NORTHBRIDGE, minute: 54 },
      { personId: "per-legend-elias-fiske", clubId: CLUB_RIVERGATE, minute: 68 },
      { personId: "per-legend-mara-finch", clubId: CLUB_NORTHBRIDGE, minute: 82 },
      { personId: "per-legend-soren-dray", clubId: CLUB_NORTHBRIDGE, minute: 88 },
    ],
  },
  {
    id: "match-riv-nba-2012-metro-final",
    date: "2012-04-28",
    season: "2011/12",
    competition: "Metro Cup",
    stage: "final",
    homeClubId: CLUB_RIVERGATE,
    awayClubId: CLUB_NORTHBRIDGE,
    homeScore: 0,
    awayScore: 1,
    venue: "Capital Arch",
    goals: [
      { personId: "per-legend-garrick-bly", clubId: CLUB_NORTHBRIDGE, minute: 64 },
    ],
  },
  {
    id: "match-nba-riv-2017-crown-final",
    date: "2017-05-27",
    season: "2016/17",
    competition: "Crown Cup",
    stage: "final",
    homeClubId: CLUB_NORTHBRIDGE,
    awayClubId: CLUB_RIVERGATE,
    homeScore: 1,
    awayScore: 2,
    venue: "Royal Causeway Stadium",
    goals: [
      { personId: "per-legend-calder-wynn", clubId: CLUB_NORTHBRIDGE, minute: 22 },
      { personId: "per-legend-idris-rowan", clubId: CLUB_RIVERGATE, minute: 71 },
      { personId: "per-legend-theo-maren", clubId: CLUB_RIVERGATE, minute: 84 },
    ],
  },
  {
    id: "match-riv-nba-2023-league",
    date: "2023-09-16",
    season: "2023/24",
    competition: "Metropolitan League",
    stage: "league",
    homeClubId: CLUB_RIVERGATE,
    awayClubId: CLUB_NORTHBRIDGE,
    homeScore: 2,
    awayScore: 2,
    venue: "Glass Wharf Ground",
    goals: [
      { personId: "per-rivergate-ilias-rowan", clubId: CLUB_RIVERGATE, minute: 14 },
      { personId: "per-northbridge-caleb-frost", clubId: CLUB_NORTHBRIDGE, minute: 39 },
      { personId: "per-rivergate-leo-arden", clubId: CLUB_RIVERGATE, minute: 66 },
      { personId: "per-northbridge-ronan-bly", clubId: CLUB_NORTHBRIDGE, minute: 81 },
    ],
  },
  {
    id: "match-nba-riv-2025-league",
    date: "2025-02-08",
    season: "2024/25",
    competition: "Metropolitan League",
    stage: "league",
    homeClubId: CLUB_NORTHBRIDGE,
    awayClubId: CLUB_RIVERGATE,
    homeScore: 1,
    awayScore: 2,
    venue: "Foundry Park",
    goals: [
      { personId: "per-rivergate-leo-arden", clubId: CLUB_RIVERGATE, minute: 33 },
      { personId: "per-northbridge-oren-fiske", clubId: CLUB_NORTHBRIDGE, minute: 59 },
      { personId: "per-rivergate-noah-finch", clubId: CLUB_RIVERGATE, minute: 87 },
    ],
  },
  {
    id: "match-eft-shc-2015-coastal-final",
    date: "2015-05-30",
    season: "2014/15",
    competition: "Coastal Cup",
    stage: "final",
    homeClubId: CLUB_EASTFORD,
    awayClubId: CLUB_STONEHAVEN,
    homeScore: 2,
    awayScore: 0,
    venue: "Bluewater Arena",
    goals: [
      { personId: "per-legend-orson-calder", clubId: CLUB_EASTFORD, minute: 17 },
      { personId: "per-legend-orson-calder", clubId: CLUB_EASTFORD, minute: 73 },
    ],
  },
  {
    id: "match-riv-kpa-2019-river-final",
    date: "2019-05-18",
    season: "2018/19",
    competition: "River Shield",
    stage: "final",
    homeClubId: CLUB_RIVERGATE,
    awayClubId: CLUB_KINGSPORT,
    homeScore: 1,
    awayScore: 0,
    venue: "Glass Wharf Ground",
    goals: [
      { personId: "per-legend-theo-maren", clubId: CLUB_RIVERGATE, minute: 62 },
    ],
  },
  {
    id: "match-kpa-vun-2021-summit-final",
    date: "2021-05-29",
    season: "2020/21",
    competition: "Summit Trophy",
    stage: "final",
    homeClubId: CLUB_KINGSPORT,
    awayClubId: CLUB_VALE_UNION,
    homeScore: 3,
    awayScore: 2,
    venue: "Skyline Steps",
    goals: [
      { personId: "per-legend-harlan-moss", clubId: CLUB_KINGSPORT, minute: 9 },
      { personId: "per-legend-victor-yarrow", clubId: CLUB_VALE_UNION, minute: 25 },
      { personId: "per-legend-idris-rowan", clubId: CLUB_KINGSPORT, minute: 48 },
      { personId: "per-legend-sera-quinn", clubId: CLUB_VALE_UNION, minute: 76 },
      { personId: "per-legend-harlan-moss", clubId: CLUB_KINGSPORT, minute: 88 },
    ],
  },
  {
    id: "match-vun-riv-2024-civic-final",
    date: "2024-05-25",
    season: "2023/24",
    competition: "Civic Cup",
    stage: "final",
    homeClubId: CLUB_VALE_UNION,
    awayClubId: CLUB_RIVERGATE,
    homeScore: 2,
    awayScore: 1,
    venue: "Union Terrace",
    goals: [
      { personId: "per-legend-sera-quinn", clubId: CLUB_VALE_UNION, minute: 28 },
      { personId: "per-rivergate-rafi-calder", clubId: CLUB_RIVERGATE, minute: 61 },
      { personId: "per-legend-victor-yarrow", clubId: CLUB_VALE_UNION, minute: 83 },
    ],
  },
  {
    id: "match-nba-shc-2024-founders-final",
    date: "2024-05-12",
    season: "2023/24",
    competition: "Founders Cup",
    stage: "final",
    homeClubId: CLUB_NORTHBRIDGE,
    awayClubId: CLUB_STONEHAVEN,
    homeScore: 2,
    awayScore: 1,
    venue: "Foundry Park",
    goals: [
      { personId: "per-northbridge-nico-hale", clubId: CLUB_NORTHBRIDGE, minute: 14 },
      { personId: "per-legend-maeve-quarry", clubId: CLUB_STONEHAVEN, minute: 57 },
      { personId: "per-northbridge-ronan-bly", clubId: CLUB_NORTHBRIDGE, minute: 79 },
    ],
  },
  {
    id: "match-eft-kpa-2025-league",
    date: "2025-03-15",
    season: "2024/25",
    competition: "Metropolitan League",
    stage: "league",
    homeClubId: CLUB_EASTFORD,
    awayClubId: CLUB_KINGSPORT,
    homeScore: 1,
    awayScore: 2,
    venue: "Lantern Field",
    goals: [
      { personId: "per-eastford-casper-holt", clubId: CLUB_EASTFORD, minute: 34 },
      { personId: "per-kingsport-soren-bright", clubId: CLUB_KINGSPORT, minute: 61 },
      { personId: "per-kingsport-kael-thorne", clubId: CLUB_KINGSPORT, minute: 90 },
    ],
  },
];
