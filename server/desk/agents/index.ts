export {
  DESK_MODEL_DEPLOYMENT,
  FACT_CHECKER_AGENT_NAME,
  LOCALIZER_AGENT_NAME,
  PRODUCER_AGENT_NAME,
  RESEARCHER_AGENT_NAME,
  type DeskAgentSpec,
} from "./shared.js";
export { factCheckerAgentSpec } from "./fact-checker.js";
export { localizerAgentSpec } from "./localizer.js";
export { producerAgentSpec } from "./producer.js";
export { researcherAgentSpec } from "./researcher.js";

import { factCheckerAgentSpec } from "./fact-checker.js";
import { localizerAgentSpec } from "./localizer.js";
import { producerAgentSpec } from "./producer.js";
import { researcherAgentSpec } from "./researcher.js";

export const DESK_AGENT_SPECS = [
  researcherAgentSpec,
  producerAgentSpec,
  factCheckerAgentSpec,
  localizerAgentSpec,
];
