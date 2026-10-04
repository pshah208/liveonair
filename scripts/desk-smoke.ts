// Real end-to-end Storyline Desk check against Foundry agents and the Foundry IQ knowledge base.
// Usage: node --env-file=.env.local --import tsx scripts/desk-smoke.ts [fixtureId] [goalEventId]
import { getArchive } from "../server/archive/index.js";
import { createStorylineDesk } from "../server/desk/index.js";
import { createArchiveRetrievalFromEnv } from "../server/desk/retrieval.js";
import { createFoundryAgentRunner } from "../server/desk/runner.js";
import { getFixture } from "../server/fixtures.js";
import type { Storyline } from "../shared/platform.js";

const fixtureId = process.argv[2] ?? "rivergate-comeback";
const fixture = getFixture(fixtureId);
const goal = process.argv[3]
  ? fixture.events.find((event) => event.id === process.argv[3])
  : fixture.events.find((event) => event.type === "goal");
if (!goal || goal.type !== "goal") {
  throw new Error("A goal event is required for the desk smoke test");
}
const clockSecond = goal.minute * 60 + goal.second;
const view = {
  matchId: `${fixture.id}-smoke`,
  fixture: { ...fixture, events: fixture.events.filter((event) => event.minute * 60 + event.second <= clockSecond) },
  clockSecond,
};

const desk = createStorylineDesk({
  archive: getArchive(),
  runner: createFoundryAgentRunner(),
  retrieval: createArchiveRetrievalFromEnv(process.env),
});
console.log(JSON.stringify(desk.health()));

const terminal = new Set(["needs_review", "approved", "rejected", "failed", "retracted"]);
const done = new Promise<Storyline>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Storyline did not finish within 180 seconds")), 180_000);
  desk.subscribe(({ storyline }) => {
    if (storyline && terminal.has(storyline.status)) {
      clearTimeout(timer);
      resolve(storyline);
    }
  });
});
desk.onEvent(view, goal);
const storyline = await done;
console.log(JSON.stringify({
  status: storyline.status,
  failureReason: storyline.failureReason,
  headline: storyline.headline,
  onAirLine: storyline.onAirLine,
  overlay: storyline.overlay,
  claims: storyline.claims.map((claim) => ({ kind: claim.kind, status: claim.status, reason: claim.reason, en: claim.text.en, sources: claim.sources })),
  trace: storyline.trace,
}, null, 2));
process.exit(storyline.status === "needs_review" ? 0 : 1);
