import type { LiveService, StorylineDesk } from "./contracts.js";
import { getArchive } from "./archive/index.js";
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
  const desk = createStorylineDesk({
    archive: getArchive(),
    runner: createFoundryAgentRunner({ endpoint: env.PROJECT_ENDPOINT }),
    retrieval: createArchiveRetrievalFromEnv(env),
  });
  const removeListener = live.addListener(desk);
  return {
    live,
    desk,
    async close() {
      removeListener();
      await live.close();
    },
  };
}
