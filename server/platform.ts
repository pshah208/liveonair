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
export function createPlatform(env: NodeJS.ProcessEnv = process.env): Platform {
  const registry = { listFixtures, getFixture, registerFixture };
  const live = createLiveService({
    transport: createTransportFromEnv(env),
    registry,
    generateMatch,
    buildFeedPlan,
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
