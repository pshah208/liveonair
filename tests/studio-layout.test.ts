import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The repo has no DOM test harness, so these checks pin the Studio live-desk layout at source level.
const studio = readFileSync(new URL("../src/StudioPage.tsx", import.meta.url), "utf8");
const deskStart = studio.indexOf('<div className="desk-grid">');
const deskEnd = studio.indexOf(") : fixture ? (", deskStart);
const desk = studio.slice(deskStart, deskEnd);
const columns = desk.split('<div className="desk-col">').slice(1);

test("Studio live desk no longer renders Match intelligence or the Fact desk", () => {
  assert.ok(deskStart > 0 && deskEnd > deskStart, "live desk grid found");
  for (const removed of ["Match intelligence", "Deterministic engine", "Verified facts", "Fact desk", "FactTicker", "MatchIntelligence", "Clear evidence"]) {
    assert.ok(!studio.includes(removed), `${removed} should not appear in StudioPage`);
  }
});

test("middle column holds only the Live board; Chance insights and Player ID tags are cut", () => {
  assert.equal(columns.length, 3, "three desk columns");
  const middle = columns[1]!;
  assert.ok(middle.includes("<LiveBoardPanel"), "Live board in middle column");
  assert.equal(middle.match(/<Panel\b/g)?.length ?? 0, 0, "no other panel beside the board");
  for (const removed of ["Chance insights", "ChanceInsightCard", "chanceInsights", "getChanceInsights", "PlayerIdTags", "computePlayerTags", "playerTags", "Player ID ·"]) {
    assert.ok(!studio.includes(removed), `${removed} should not appear in StudioPage`);
  }
});

test("lower-third overlay export no longer carries player tags", () => {
  const exportCall = studio.slice(studio.indexOf("downloadJson("), studio.indexOf("})} />", studio.indexOf("downloadJson(")));
  assert.ok(exportCall.includes("onAirLine") && exportCall.includes("claimSources"), "overlay export still has its core fields");
  assert.ok(!exportCall.includes("playerTags"), "playerTags dropped from the overlay JSON");
});

test("every desk column keeps at least one panel so the grid has no empty column", () => {
  for (const column of columns) assert.ok(/<(Panel|LiveBoardPanel)\b/.test(column));
  assert.ok(columns[2]!.includes('title="Lower-third"') && columns[2]!.includes('title="Storyline queue"'));
});
