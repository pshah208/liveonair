export {
  DESK_MODEL_DEPLOYMENT,
  DIRECTOR_AGENT_NAME,
  FACT_CHECKER_AGENT_NAME,
  LOCALIZER_AGENT_NAME,
  PRODUCER_AGENT_NAME,
  RESEARCHER_AGENT_NAME,
  TACTICS_ANALYST_AGENT_NAME,
  type DeskAgentSpec,
} from "./shared.js";
export { directorAgentSpec } from "./director.js";
export { factCheckerAgentSpec } from "./fact-checker.js";
export { localizerAgentSpec } from "./localizer.js";
export { producerAgentSpec } from "./producer.js";
export { researcherAgentSpec } from "./researcher.js";
export { tacticsAnalystAgentSpec } from "./tactics-analyst.js";

import { directorAgentSpec } from "./director.js";
import { factCheckerAgentSpec } from "./fact-checker.js";
import { localizerAgentSpec } from "./localizer.js";
import { producerAgentSpec } from "./producer.js";
import { researcherAgentSpec } from "./researcher.js";
import { tacticsAnalystAgentSpec } from "./tactics-analyst.js";

export const DESK_AGENT_SPECS = [
  researcherAgentSpec,
  producerAgentSpec,
  factCheckerAgentSpec,
  localizerAgentSpec,
  directorAgentSpec,
  tacticsAnalystAgentSpec,
];

export { PLAYER_ANALYST_AGENT_NAME, playerAnalystAgentSpec } from "./player-analyst.js";
import { playerAnalystAgentSpec } from "./player-analyst.js";

/** Every Foundry agent the app uses, for provisioning: the storyline desk plus the player analyst. */
export const ALL_AGENT_SPECS = [...DESK_AGENT_SPECS, playerAnalystAgentSpec];