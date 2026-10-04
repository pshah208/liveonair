import type { StressFeedItem, StressKind } from "../../shared/platform.js";
import type { MatchFixture } from "../../shared/types.js";
import { cloneFixture, eventSecond, lcg, sortEventsStable } from "../fixtures.js";

export function buildFeedPlan(fixture: MatchFixture, stress: boolean): StressFeedItem[] {
  const workingFixture = cloneFixture(fixture);
  const basePlan: StressFeedItem[] = sortEventsStable(workingFixture.events).map((event) => ({
    publishAtSecond: eventSecond(event),
    event: { ...event },
  }));

  if (!stress) {
    return basePlan;
  }

  const rand = lcg(workingFixture.seed ^ workingFixture.id.length ^ workingFixture.events.length);
  const mutablePlan = basePlan.map((item) => ({ ...item, event: { ...item.event } }));
  const candidateIndexes = mutablePlan
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !["kickoff", "halftime", "fulltime"].includes(item.event.type));

  const outOfOrderIndexes: number[] = [];
  while (outOfOrderIndexes.length < 2 && candidateIndexes.length > 0) {
    const choice = candidateIndexes.splice(Math.floor(rand() * candidateIndexes.length), 1)[0];
    outOfOrderIndexes.push(choice.index);
  }
  for (const index of outOfOrderIndexes) {
    const lateBy = 20 + Math.floor(rand() * 21);
    mutablePlan[index] = {
      publishAtSecond: mutablePlan[index]!.publishAtSecond + lateBy,
      event: { ...mutablePlan[index]!.event },
      stress: "out_of_order",
    };
  }

  const duplicates: StressFeedItem[] = [];
  const duplicateCount = 2 + Math.floor(rand() * 2);
  const duplicatePool = mutablePlan
    .map((item, index) => ({ item, index }))
    .filter(({ index, item }) => !outOfOrderIndexes.includes(index) && !["kickoff", "halftime", "fulltime"].includes(item.event.type));
  for (let count = 0; count < duplicateCount && duplicatePool.length > 0; count += 1) {
    const choice = duplicatePool.splice(Math.floor(rand() * duplicatePool.length), 1)[0]!;
    duplicates.push({
      publishAtSecond: choice.item.publishAtSecond + 2 + Math.floor(rand() * 5),
      event: { ...choice.item.event },
      stress: "duplicate",
    });
  }

  const correctionBase = workingFixture.events.find((event) => event.id === workingFixture.correctionEventId);
  if (!correctionBase || correctionBase.type !== "goal") {
    throw new RangeError(`Fixture ${workingFixture.id} is missing correction goal ${workingFixture.correctionEventId}`);
  }

  const correctionItem: StressFeedItem = {
    publishAtSecond: workingFixture.correctionAvailableAt,
    event: { ...correctionBase, revision: correctionBase.revision + 1, rescinded: true },
    stress: "late_correction" satisfies StressKind,
  };

  return [...mutablePlan, ...duplicates, correctionItem]
    .sort((a, b) => a.publishAtSecond - b.publishAtSecond || eventSecond(a.event) - eventSecond(b.event) || a.event.id.localeCompare(b.event.id) || a.event.revision - b.event.revision);
}
