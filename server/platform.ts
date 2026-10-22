import type { LiveService, StorylineDesk } from "./contracts.js";
import type { ChanceInsightFeed } from "./chanceInsights.js";
import { getArchive } from "./archive/index.js";
import { createChanceInsightFeed } from "./chanceInsights.js";
import { createStorylineDesk } from "./desk/index.js";
import { createArchiveRetrievalFromEnv } from "./desk/retrieval.js";
import { createFoundryAgentRunner } from "./desk/runner.js";
import { getFixture, listFixtures, registerFixture } from "./fixtures.js";
import { createLiveService } from "./live/service.js";
import { createTransportFromEnv } from "./live/transport.js";
import { buildFeedPlan } from "./matchlab/feed.js";
import { generateMatch } from "./matchlab/generator.js";

export interface Platform {
  live: LiveService;
  desk: StorylineDesk;
  /** Optional so partial test doubles of Platform still type-check when cast. */
  insights?: ChanceInsightFeed;
  close(): Promise<void>;
}

/**
 * Wires the live feed (Fabric Eventstream when configured, otherwise an explicitly labelled local bus)
 * to the Storyline Desk (Foundry agents when PROJECT_ENDPOINT is set, otherwise explicitly unconfigured).
 */
function runningUnderTestRunner(env: NodeJS.ProcessEnv): boolean {
  return env.npm_lifecycle_event === "test"
    || typeof env.NODE_TEST_CONTEXT === "string"
    || process.argv.includes("--test")
    || process.execArgv.includes("--test");
}

export function readLiveSource(env: NodeJS.ProcessEnv): "canonical" | "opta-format" {
  const value = env.LIVE_SOURCE?.trim();
  if (!value || value === "canonical") return "canonical";
  if (value === "opta-format") return "opta-format";
  console.warn(JSON.stringify({
    level: "warn",
    reason: "Unknown LIVE_SOURCE; using canonical",
    liveSource: value,
  }));
  return "canonical";
}

/** Idle minutes before a synthetic demo. Unset means 10, except under the test runner where it stays off. */
export function readWatchdogMinutes(env: NodeJS.ProcessEnv): number {
  const raw = env.DEMO_WATCHDOG_MINUTES;
  if (raw === undefined || raw.trim() === "") {
    return runningUnderTestRunner(env) ? 0 : 10;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return runningUnderTestRunner(env) ? 0 : 10;
  return parsed;
}

export function createPlatform(env: NodeJS.ProcessEnv = process.env): Platform {
  const registry = { listFixtures, getFixture, registerFixture };
  const live = createLiveService({
    transport: createTransportFromEnv(env),
    registry,
    generateMatch,
    buildFeedPlan,
    liveSource: readLiveSource(env),
    watchdogMinutes: readWatchdogMinutes(env),
  });
  const insights = createChanceInsightFeed();
  const desk = createStorylineDesk({
    archive: getArchive(),
    runner: createFoundryAgentRunner({ endpoint: env.PROJECT_ENDPOINT }),
    retrieval: createArchiveRetrievalFromEnv(env),
  });
  // Insight feed first so a goal storyline can read the issued insight in the same event.
  const removeInsights = live.addListener(insights);
  const removeDesk = live.addListener(desk);
  const unsubscribeInsights = insights.subscribe((insight) => desk.applyChanceInsight?.(insight));
  return {
    live,
    desk,
    insights,
    async close() {
      unsubscribeInsights();
      removeInsights();
      removeDesk();
      await live.close();
    },
  };
}
