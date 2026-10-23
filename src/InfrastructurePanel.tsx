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

type State = "ok" | "warn" | "idle";
type Node = { icon: string; title: string; service: string; line: string; state: State; stateLabel: string; chips?: string[] };

function flow(health: AppHealth | null, desk: DeskHealth | null, live: LiveStatus | null): Node[] {
  const fabric = live?.transport === "fabric-eventstream";
  const running = live?.state === "running";
  const paused = live?.state === "paused";
  return [
    {
      icon: "⚽", title: "Sources", service: "Feed or footage", line: "Pick one input.",
      chips: ["MatchLab feed", "Live video"],
      state: running || paused ? "ok" : "idle",
      stateLabel: paused ? `Paused · ${live?.eventsReceived ?? 0} events` : running ? `Live · ${live?.eventsReceived ?? 0} events` : live?.state === "finished" ? "Full time" : "Idle"
    },
    {
      icon: "⚡", title: "Ingest", service: "Fabric Eventstream", line: "Events stream in, land in Eventhouse.",
      state: fabric ? "ok" : "warn", stateLabel: fabric ? `Connected${live?.lagMs !== undefined ? ` · ${live.lagMs} ms` : ""}` : "Local bus"
    },
    {
      icon: "📊", title: "Match engine", service: "Container Apps", line: "Score, stats, xG, story cards.",
      state: health ? "ok" : "warn", stateLabel: health ? `API v${health.version}` : "Checking"
    },
    {
      icon: "🤖", title: "Storyline agents", service: "Microsoft Foundry", line: "Storylines plus a player-analyst note.",
      state: desk?.mode === "foundry-agents" ? "ok" : "warn", stateLabel: desk?.mode === "foundry-agents" ? `${desk.agents.length} agents` : "Not configured"
    },
    {
      icon: "✅", title: "Producer approval", service: "Live desk", line: "Nothing airs without a human yes.",
      state: "ok", stateLabel: "Human in the loop"
    },
    {
      icon: "📺", title: "On air", service: "Outputs", line: "Graphics, reel, recap, voice.",
      chips: ["Lower-third", "Highlights", "Recap"],
      state: health?.ai.configured ? "ok" : "warn", stateLabel: health?.ai.configured ? health.ai.deployment : "Narrator offline"
    }
  ];
}

const DESKS = [
  { icon: "🎙️", title: "Live desk", chips: ["Live board", "Storyline queue", "Corrections"], line: "Run the match, approve storylines." },
  { icon: "🎬", title: "Recap & highlights", chips: ["Auto-cut reel", "Written recap", "EN · ES · FR · PT"], line: "Every goal, red card and approved story." },
  { icon: "📈", title: "Player analysis", chips: ["Heat maps", "Illustrative activity score", "Analyst note"], line: "Every player's numbers from the feed." },
  { icon: "🔍", title: "Video lab", chips: ["Hudl-style tags", "Notes", "Pundit reel"], line: "Manual tagging cut into highlights." },
  { icon: "🎯", title: "Player cam", chips: ["One player", "Spotlight", "Vertical cut"], line: "Studio highlights of a specific player." }
];

const GUARDRAILS = [
  { icon: "🔗", text: "Every claim cites a source" },
  { icon: "🚫", text: "Unverified names & numbers rejected" },
  { icon: "🧑‍⚖️", text: "Producer approves before air" },
  { icon: "↩️", text: "Corrections retract dependent copy" },
  { icon: "🔒", text: "Clips need rights; source deleted" }
];

const HOSTING = ["Container Apps", "Container Registry", "Managed identity", "Fabric Eventstream", "Eventhouse (KQL)", "Foundry agents", "AI Search", "Azure AI Speech", "Bicep", "GitHub Actions"];

const NEXT = ["Measured player tracking feed", "Licensed data feed", "Entra ID roles", "Multi-match state", "Graphics-engine output"];

export function InfrastructurePanel({ open, onToggle, health, desk, live }: InfrastructurePanelProps) {
  return (
    <section className={`infra${open ? " is-open" : ""}`} aria-labelledby="infra-title">
      <button type="button" className="infra__toggle" onClick={onToggle} aria-expanded={open} aria-controls="infra-body">
        <span>
          <span className="eyebrow">Architecture</span>
          <span id="infra-title" className="infra__title">How Live on Air works</span>
        </span>
        <span className="infra__chevron" aria-hidden="true">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div id="infra-body" className="infra__body">
          <ol className="how-flow" aria-label="Application flow">
            {flow(health, desk, live).map((node, index) => (
              <li className={`how-node${index === 4 ? " how-node--human" : ""}`} key={node.title}>
                <span className="how-node__icon" aria-hidden="true">{node.icon}</span>
                <strong>{node.title}</strong>
                <span className="how-node__service">{node.service}</span>
                <span className="how-node__line">{node.line}</span>
                {node.chips && <span className="how-node__chips">{node.chips.map((chip) => <span className="tag" key={chip}>{chip}</span>)}</span>}
                <span className="how-node__state"><span className={`dot dot--${node.state}`} aria-hidden="true" />{node.stateLabel}</span>
              </li>
            ))}
          </ol>

          <div className="how-section">
            <h3 className="how-section__title">Five desks</h3>
            <div className="how-desks">
              {DESKS.map((item) => (
                <article className="how-desk" key={item.title}>
                  <span className="how-desk__icon" aria-hidden="true">{item.icon}</span>
                  <strong>{item.title}</strong>
                  <span className="how-desk__line">{item.line}</span>
                  <span className="how-node__chips">{item.chips.map((chip) => <span className="tag" key={chip}>{chip}</span>)}</span>
                </article>
              ))}
            </div>
          </div>

          <div className="how-section">
            <h3 className="how-section__title">Trust guardrails</h3>
            <ul className="how-guards">
              {GUARDRAILS.map((item) => <li key={item.text}><span aria-hidden="true">{item.icon}</span>{item.text}</li>)}
            </ul>
          </div>

          <div className="how-footer">
            <div><h3 className="how-section__title">Built on Azure</h3><div className="chips">{HOSTING.map((item) => <span className="tag" key={item}>{item}</span>)}</div></div>
            <div><h3 className="how-section__title">Next</h3><div className="chips">{NEXT.map((item) => <span className="tag tag--muted" key={item}>{item}</span>)}</div></div>
          </div>
        </div>
      )}
    </section>
  );
}