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

test("Chance insights sits directly under the Live board in the middle column", () => {
  assert.equal(columns.length, 3, "three desk columns");
  const middle = columns[1]!;
  const board = middle.indexOf("<LiveBoardPanel");
  const chances = middle.indexOf('title="Chance insights"');
  assert.ok(board >= 0, "Live board in middle column");
  assert.ok(chances > board, "Chance insights follows the Live board");
  assert.equal(middle.match(/<Panel\b/g)?.length, 1, "Chance insights is the only panel beside the board");
  assert.ok(middle.includes("chance-list--scroll"), "chance list scrolls so the middle column stays balanced");
  assert.ok(!columns[2]!.includes("Chance insights"), "Chance insights moved out of the right column");
});

test("every desk column keeps at least one panel so the grid has no empty column", () => {
  for (const column of columns) assert.ok(/<(Panel|LiveBoardPanel)\b/.test(column));
  assert.ok(columns[2]!.includes('title="Lower-third"') && columns[2]!.includes('title="Storyline queue"'));
});
