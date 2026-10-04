import assert from "node:assert/strict";
import test from "node:test";

import { buildCutList, buildFfmpegScript, buildHighlightReel, eventSecondOf, formatTimecode, latestRevisions, toRecordingSeconds } from "../shared/highlights.js";
import type { Storyline } from "../shared/platform.js";
import type { MatchFixture } from "../shared/types.js";
import { getFixture } from "../server/fixtures.js";

function fixture(): MatchFixture {
  return structuredClone(getFixture("rivergate-comeback"));
}

function storyline(eventId: string, status: Storyline["status"], overlay: string): Storyline {
  const localized = (text: string) => ({ en: text, es: "", fr: "" });
  return {
    id: `story-${eventId}`,
    matchId: "m1",
    triggerEventIds: [eventId],
    triggerMinute: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    status,
    priority: 80,
    headline: localized(`Headline ${eventId}`),
    onAirLine: localized("line"),
    overlay: localized(overlay),
    claims: [],
    trace: [],
    version: 1
  } as Storyline;
}

test("reel includes every goal, is chronological and non-overlapping", () => {
  const match = fixture();
  const reel = buildHighlightReel(match);
  const goals = match.events.filter((event) => event.type === "goal" && !event.rescinded);
  for (const goal of goals) {
    assert.ok(reel.clips.some((clip) => clip.eventIds.includes(goal.id)), `goal ${goal.id} missing`);
  }
  for (let index = 1; index < reel.clips.length; index += 1) {
    assert.ok(reel.clips[index].startSecond >= reel.clips[index - 1].endSecond, "clips overlap or are out of order");
  }
  assert.ok(reel.clips.length <= 8);
  assert.equal(reel.totalMatchSeconds, reel.clips.reduce((sum, clip) => sum + clip.endSecond - clip.startSecond, 0));
});

test("clip windows contain their key event and score progresses", () => {
  const reel = buildHighlightReel(fixture());
  let previousTotal = -1;
  for (const clip of reel.clips) {
    assert.ok(clip.eventIds.includes(clip.keyEventId));
    const total = clip.scoreAfter.home + clip.scoreAfter.away;
    assert.ok(total >= previousTotal);
    previousTotal = total;
  }
});

test("selection is deterministic and respects maxClips", () => {
  const first = buildHighlightReel(fixture(), [], { maxClips: 3 });
  const second = buildHighlightReel(fixture(), [], { maxClips: 3 });
  assert.deepEqual(first, second);
  assert.ok(first.clips.length <= 3);
  assert.ok(first.clips.every((clip) => clip.kind === "goal" || clip.importance >= 75));
});

test("approved storyline supplies the caption; retracted storylines are ignored", () => {
  const match = fixture();
  const goal = match.events.find((event) => event.type === "goal")!;
  const approved = buildHighlightReel(match, [storyline(goal.id, "approved", "Family legacy goal")]);
  const clip = approved.clips.find((item) => item.keyEventId === goal.id)!;
  assert.equal(clip.caption, "Family legacy goal");
  assert.equal(clip.storylineId, `story-${goal.id}`);

  const retracted = buildHighlightReel(match, [storyline(goal.id, "retracted", "Should not show")]);
  assert.notEqual(retracted.clips.find((item) => item.keyEventId === goal.id)?.caption, "Should not show");
});

test("rescinded goal becomes a disallowed-goal clip and does not count in the score", () => {
  const match = fixture();
  const goal = match.events.find((event) => event.id === match.correctionEventId) ?? match.events.find((event) => event.type === "goal")!;
  goal.rescinded = true;
  const reel = buildHighlightReel(match);
  const clip = reel.clips.find((item) => item.keyEventId === goal.id);
  assert.equal(clip?.kind, "disallowed_goal");
  const last = reel.clips[reel.clips.length - 1];
  const activeGoals = match.events.filter((event) => event.type === "goal" && !event.rescinded && eventSecondOf(event) <= last.endSecond).length;
  assert.equal(last.scoreAfter.home + last.scoreAfter.away, activeGoals);
});

test("uptoSecond limits the reel to events already played", () => {
  const reel = buildHighlightReel(fixture(), [], { uptoSecond: 30 * 60 });
  assert.ok(reel.clips.every((clip) => clip.minute <= 30));
});

test("live views with several revisions of a goal count only the latest revision", () => {
  const match = fixture();
  const goal = match.events.find((event) => event.type === "goal")!;
  match.events.push({ ...goal, revision: goal.revision + 1, rescinded: true });
  const reel = buildHighlightReel(match);
  const clip = reel.clips.find((item) => item.keyEventId === goal.id);
  assert.equal(clip?.kind, "disallowed_goal");
  assert.equal(new Set(clip?.eventIds).size, clip?.eventIds.length);
  const goals = latestRevisions(match.events).filter((event) => event.type === "goal" && !event.rescinded).length;
  const last = reel.clips[reel.clips.length - 1];
  assert.ok(last.scoreAfter.home + last.scoreAfter.away <= goals);
});

test("cut list maps match time to recording time with half-time break", () => {
  assert.equal(formatTimecode(3725.5), "01:02:05.500");
  assert.equal(toRecordingSeconds(600, { kickoffOffsetSeconds: 120, halftimeBreakSeconds: 900 }), 720);
  assert.equal(toRecordingSeconds(50 * 60, { kickoffOffsetSeconds: 120, halftimeBreakSeconds: 900 }), 120 + 3000 + 900);
  const reel = buildHighlightReel(fixture());
  const entries = buildCutList(reel, { kickoffOffsetSeconds: 60 });
  assert.equal(entries.length, reel.clips.length);
  assert.ok(entries.every((entry) => entry.outSeconds > entry.inSeconds));
  const script = buildFfmpegScript(reel, { kickoffOffsetSeconds: 60 });
  assert.match(script, /ffmpeg -y -f concat/u);
  assert.equal((script.match(/-ss /gu) ?? []).length, reel.clips.length);
});
