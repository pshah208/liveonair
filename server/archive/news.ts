import type { ArchiveNewsItem } from "../../shared/platform.js";
import {
  CLUB_EASTFORD,
  CLUB_KINGSPORT,
  CLUB_NORTHBRIDGE,
  CLUB_RIVERGATE,
  CLUB_STONEHAVEN,
  CLUB_VALE_UNION,
} from "./data.js";

const OUTLET = "Synthetic Sports Wire";

function item(input: Omit<ArchiveNewsItem, "outlet" | "synthetic">): ArchiveNewsItem {
  return { ...input, outlet: OUTLET, synthetic: true };
}

/**
 * Synthetic pre-match news wire. Dates sit before a typical 2025/26 broadcast window.
 * Every item is fictional and attributed to a fictional outlet.
 */
export const newsItems: ArchiveNewsItem[] = [
  item({
    id: "news-riv-voss-pressure-2025-09-28",
    publishedAt: "2025-09-28",
    headline: "Voss hears the questions after three winless weeks",
    body: "Synthetic Sports Wire: Helena Voss, head coach of Rivergate FC since 2019, is under pressure after 3 winless league matches. Her Rivergate record remains 214 matches, 118 wins, 46 draws and 50 losses. No quote in this item is from a real person.",
    clubIds: [CLUB_RIVERGATE],
    personIds: ["per-coach-rivergate-helena-voss"],
    themes: ["manager_pressure", "form"],
  }),
  item({
    id: "news-riv-rowan-return-2025-10-02",
    publishedAt: "2025-10-02",
    headline: "Rowan back in the Rivergate matchday group",
    body: "Synthetic Sports Wire: Ilias Rowan has returned to Rivergate FC training after 6 weeks out. The forward's archive career lists 25 goals for Rivergate since 2022. This injury note is synthetic.",
    clubIds: [CLUB_RIVERGATE],
    personIds: ["per-rivergate-ilias-rowan"],
    themes: ["injury_return"],
  }),
  item({
    id: "news-riv-finch-contract-2025-09-18",
    publishedAt: "2025-09-18",
    headline: "Finch contract talks continue at Glass Wharf",
    body: "Synthetic Sports Wire: Noah Finch is in contract talks with Rivergate FC. His deal is reported, in this synthetic item, to have 1 year left. No agent or fee is named because none was recorded.",
    clubIds: [CLUB_RIVERGATE],
    personIds: ["per-rivergate-noah-finch"],
    themes: ["contract"],
  }),
  item({
    id: "news-nba-hale-milestone-2025-10-04",
    publishedAt: "2025-10-04",
    headline: "Hale two goals from a half-century",
    body: "Synthetic Sports Wire: Nico Hale has 48 career goals for Northbridge Athletic and is 2 short of 50. The figure is the archive career total, not a live match count.",
    clubIds: [CLUB_NORTHBRIDGE],
    personIds: ["per-northbridge-nico-hale"],
    themes: ["milestone"],
  }),
  item({
    id: "news-nba-okonkwo-rivalry-2025-10-06",
    publishedAt: "2025-10-06",
    headline: "Okonkwo calls the Rivergate meeting a measuring stick",
    body: "Synthetic Sports Wire: Idris Okonkwo, Northbridge Athletic head coach since 2020, said the next meeting with Rivergate FC is a measuring stick, not a feud. His Northbridge record is 198 matches, 109 wins, 41 draws and 48 losses. The quote is synthetic.",
    clubIds: [CLUB_NORTHBRIDGE, CLUB_RIVERGATE],
    personIds: ["per-coach-northbridge-idris-okonkwo"],
    themes: ["rivalry", "manager_pressure"],
  }),
  item({
    id: "news-nba-form-2025-10-01",
    publishedAt: "2025-10-01",
    headline: "Northbridge arrive on a five-match winning run",
    body: "Synthetic Sports Wire: Northbridge Athletic have won 5 matches in a row under Idris Okonkwo. The run is a synthetic pre-match note, not a live table.",
    clubIds: [CLUB_NORTHBRIDGE],
    personIds: ["per-coach-northbridge-idris-okonkwo"],
    themes: ["form"],
  }),
  item({
    id: "news-riv-pell-family-2025-10-05",
    publishedAt: "2025-10-05",
    headline: "Pell siblings on opposite benches again",
    body: "Synthetic Sports Wire: Assistant coaches Marcus Pell of Rivergate FC and Lila Pell of Northbridge Athletic are siblings. Both have been on the staff for the recent meetings between the clubs. This family note is synthetic.",
    clubIds: [CLUB_RIVERGATE, CLUB_NORTHBRIDGE],
    personIds: ["per-coach-rivergate-marcus-pell", "per-coach-northbridge-lila-pell"],
    themes: ["rivalry"],
  }),
  item({
    id: "news-eft-kerr-pressure-2025-09-22",
    publishedAt: "2025-09-22",
    headline: "Kerr needs a result to quiet the Eastford questions",
    body: "Synthetic Sports Wire: Naomi Kerr, Eastford Town head coach since 2021, is under pressure. Her record is 156 matches, 64 wins, 40 draws and 52 losses.",
    clubIds: [CLUB_EASTFORD],
    personIds: ["per-coach-eastford-naomi-kerr"],
    themes: ["manager_pressure"],
  }),
  item({
    id: "news-shc-brook-return-2025-09-30",
    publishedAt: "2025-09-30",
    headline: "Brook expected back for Stonehaven",
    body: "Synthetic Sports Wire: Tavian Brook is expected to return for Stonehaven City after 4 weeks out. Edgar Quill called the return timely. Both the absence and the quote are synthetic.",
    clubIds: [CLUB_STONEHAVEN],
    personIds: ["per-stonehaven-tavian-brook", "per-coach-stonehaven-edgar-quill"],
    themes: ["injury_return"],
  }),
  item({
    id: "news-kpa-moss-contract-2025-09-12",
    publishedAt: "2025-09-12",
    headline: "Moss enters the last year of her Kingsport deal",
    body: "Synthetic Sports Wire: Freya Moss, Kingsport Albion head coach since 2018, has 1 year left on her contract. Her record is 276 matches, 132 wins, 61 draws and 83 losses.",
    clubIds: [CLUB_KINGSPORT],
    personIds: ["per-coach-kingsport-freya-moss"],
    themes: ["contract"],
  }),
  item({
    id: "news-vun-briggs-milestone-2025-10-03",
    publishedAt: "2025-10-03",
    headline: "Briggs one win from 120 at Vale Union",
    body: "Synthetic Sports Wire: Conrad Briggs has 119 wins from 268 matches as Vale Union head coach since 2018. One more win would make 120. The count is his synthetic staff record.",
    clubIds: [CLUB_VALE_UNION],
    personIds: ["per-coach-vale-conrad-briggs"],
    themes: ["milestone"],
  }),
  item({
    id: "news-riv-nba-buildup-2025-10-07",
    publishedAt: "2025-10-07",
    headline: "Old finalists meet with both dugouts under scrutiny",
    body: "Synthetic Sports Wire: Rivergate FC and Northbridge Athletic meet again after finals in 2004, 2008, 2012 and 2017. Helena Voss is 3 league matches without a win; Idris Okonkwo's side have won 5 in a row. All of this copy is synthetic.",
    clubIds: [CLUB_RIVERGATE, CLUB_NORTHBRIDGE],
    personIds: ["per-coach-rivergate-helena-voss", "per-coach-northbridge-idris-okonkwo"],
    themes: ["rivalry", "form", "manager_pressure"],
  }),
];
