import type { AppHealth } from "../shared/types.js";
import type { LiveStatus } from "../shared/platform.js";

export type DeskHealth = { mode: "foundry-agents" | "unconfigured"; agents: string[]; retrieval: string };

type InfrastructurePanelProps = {
  open: boolean;
  onToggle: () => void;
  health: AppHealth | null;
  desk: DeskHealth | null;
  live: LiveStatus | null;
};

type Stage = {
  step: string;
  title: string;
  service: string;
  detail: string;
  state: "ok" | "warn" | "idle";
  stateLabel: string;
};

function stages(health: AppHealth | null, desk: DeskHealth | null, live: LiveStatus | null): Stage[] {
  const fabric = live?.transport === "fabric-eventstream";
  const running = live?.state === "running";
  return [
    {
      step: "1",
      title: "Synthetic match feed",
      service: "MatchLab · fixtures",
      detail: "Original clubs, players and football-realistic events, including corrections. No licensed data or footage.",
      state: running ? "ok" : "idle",
      stateLabel: running ? `Live · ${live?.eventsReceived ?? 0} events` : live?.state === "finished" ? "Full time" : "Idle"
    },
    {
      step: "2",
      title: "Real-time ingestion",
      service: "Fabric Eventstream",
      detail: "A custom endpoint takes each event in; Eventstream fans it out to Eventhouse and back to the app.",
      state: fabric ? "ok" : "warn",
      stateLabel: fabric ? `Connected${live?.lagMs !== undefined ? ` · ${live.lagMs} ms lag` : ""}` : "Local bus fallback"
    },
    {
      step: "3",
      title: "Event store and archive",
      service: "Fabric Eventhouse (KQL)",
      detail: "Typed MatchEvents via an update policy, plus the synthetic archive: clubs, careers, family links and historic finals.",
      state: fabric ? "ok" : "idle",
      stateLabel: fabric ? "Ingesting" : "Not in use"
    },
    {
      step: "4",
      title: "Match intelligence",
      service: "Azure Container Apps",
      detail: "A deterministic engine computes score, stats, illustrative xG and evidence-linked story cards on every event.",
      state: health ? "ok" : "warn",
      stateLabel: health ? `API v${health.version}` : "Checking"
    },
    {
      step: "5",
      title: "Storyline agents",
      service: "Microsoft Foundry",
      detail: "Researcher (Foundry IQ over Azure AI Search), producer, fact-checker and localizer (EN/ES/FR), behind a deterministic claim verifier.",
      state: desk?.mode === "foundry-agents" ? "ok" : "warn",
      stateLabel: desk?.mode === "foundry-agents" ? `${desk.agents.length} agents` : "Not configured"
    },
    {
      step: "6",
      title: "Producer and outputs",
      service: "Studio desk",
      detail: "A human approves each storyline. Approved copy drives lower-thirds, narrated recaps and the auto-cut highlight reel, in three languages.",
      state: health?.ai.configured ? "ok" : "warn",
      stateLabel: health?.ai.configured ? health.ai.deployment : "Narrator offline"
    }
  ];
}

const OUTPUTS = [
  "Lower-third overlay (timed JSON with claim sources)",
  "Narrated recap: analyst or casual, English, Spanish or French",
  "Highlight reel ranked from verified events, captioned by approved storylines",
  "Reel cut from the Video lab clip automatically, or rendered from data for synthetic matches",
  "Commentary voice reads each highlight caption (sound toggle)",
  "Cut list and ffmpeg script for an edit suite",
  "Video lab: events tagged from your own clip by a vision model plus up to 5 producer tags, streamed like a live feed",
  "Player cam: a fan's personal reel of one player, with a spotlight and a vertical cut that follows them"
];

const PHASE_TWO = [
  "Licensed data-feed adapter into Eventstream",
  "Entra ID sign-in with producer and editor roles",
  "Shared state for many concurrent matches",
  "Graphics-engine output and live video sync",
  "Video lab worker on Blob Storage, Service Bus and Container Apps Jobs, with player tracking"
];

const HOSTING = [
  "Azure Container Apps (1 replica, SSE)",
  "Azure Container Registry",
  "Managed identity · keyless Azure auth",
  "Log Analytics",
  "Bicep infrastructure as code",
  "GitHub Actions CI"
];

const GUARDRAILS = [
  "Every claim is matched to feed events or archive records before it reaches a producer.",
  "Agent copy that adds names or numbers not in verified claims is rejected and retried.",
  "Nothing goes on air without producer approval.",
  "A goal correction retracts dependent storylines, facts and highlight captions.",
  "Video lab uploads require confirming you own or license the clip; the source file is deleted after processing."
];

export function InfrastructurePanel({ open, onToggle, health, desk, live }: InfrastructurePanelProps) {
  return (
    <section className={`infra${open ? " is-open" : ""}`} aria-labelledby="infra-title">
      <button type="button" className="infra__toggle" onClick={onToggle} aria-expanded={open} aria-controls="infra-body">
        <span>
          <span className="eyebrow">Architecture</span>
          <span id="infra-title" className="infra__title">How MatchLens works</span>
        </span>
        <span className="infra__chevron" aria-hidden="true">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div id="infra-body" className="infra__body">
          <ol className="pipeline">
            {stages(health, desk, live).map((stage) => (
              <li className="pipeline__stage" key={stage.step}>
                <div className="pipeline__head">
                  <span className="pipeline__step">{stage.step}</span>
                  <span className={`dot dot--${stage.state}`} aria-hidden="true" />
                  <span className="pipeline__state">{stage.stateLabel}</span>
                </div>
                <strong>{stage.title}</strong>
                <span className="pipeline__service">{stage.service}</span>
                <p>{stage.detail}</p>
              </li>
            ))}
          </ol>
          <div className="infra__footer">
            <div>
              <h3>What it produces</h3>
              <ul className="plain-list">{OUTPUTS.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
            <div>
              <h3>Trust guardrails</h3>
              <ul className="plain-list">{GUARDRAILS.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
            <div>
              <h3>Hosting and operations</h3>
              <div className="chips">{HOSTING.map((item) => <span className="tag" key={item}>{item}</span>)}</div>
              <h3 className="infra__subhead">Phase 2: production path</h3>
              <ul className="plain-list">{PHASE_TWO.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
