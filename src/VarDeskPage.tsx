import { Panel } from "./components.js";

const FLOW = [
  { title: "Trigger", service: "Fabric Eventstream", detail: "A var_check or var_review event in the live feed (or the producer pressing Review) wakes the desk. Nothing runs between reviews." },
  { title: "Clip the incident", service: "Video worker", detail: "Cuts the seconds before and after the incident from every licensed angle and samples frames, the same way the Video lab does." },
  { title: "Read the incident", service: "Foundry agent · vision", detail: "Describes what happened (contact, ball position, hand or arm position, attacking phase) and cites the frames it relied on." },
  { title: "Check the Laws", service: "Foundry IQ · Azure AI Search", detail: "Retrieves the relevant Law and competition VAR protocol passages from a knowledge base over the current rulebook." },
  { title: "Recommend", service: "Foundry agent + deterministic guard", detail: "Combines the incident and the Law into a recommendation with confidence. Any claim not backed by a frame or a Law passage is rejected." },
  { title: "Human decides", service: "Referee and VAR", detail: "Officials confirm or overturn. The outcome flows back into the Studio Desk as a correction, storyline and fan explainer." }
];

const REUSED = [
  "Fabric Eventstream ingestion and the live event contract",
  "The video worker (ffmpeg sampling, vision tagging, fail-closed footage check)",
  "Foundry agents with the fact-checker and deterministic claim guard",
  "The correction flow that retracts and rebuilds storylines and highlights",
  "Multilingual output for fan-facing explanations"
];

const GUARDRAILS = [
  "Advisory only. Live on Air never makes or announces a decision; officials do.",
  "Every recommendation cites the frames and the Law passage it relies on.",
  "Clearly time-boxed so it never delays the restart.",
  "Full audit trail of what the agents saw, retrieved and suggested.",
  "Only licensed match angles and a licensed copy of the Laws are indexed."
];

const LIMITS = [
  "Offside needs calibrated multi-camera player tracking (as semi-automated offside technology does). Sampled frames can't draw a reliable line.",
  "Real reviews need low-latency, multi-angle licensed feeds; the hackathon has neither.",
  "Use in an official match would need competition and IFAB protocol approval.",
  "Where the MVP shines: explaining a VAR decision to fans, in their language, with the Law it rests on."
];

export function VarDeskPage({ onOpenStudio }: { onOpenStudio: () => void }) {
  return (
    <main className="page var-desk">
      <section className="panel var-hero">
        <div className="var-hero__copy">
          <span className="eyebrow">VAR Desk · next phase</span>
          <h1>An assistant that only wakes up when the referee checks the screen</h1>
          <p className="lede">
            When a VAR check or review is called during a live match, Live on Air agents pull the incident from the feed, read it frame by frame,
            look up the current Laws of the Game with Foundry IQ and give officials a cited recommendation in seconds. The decision stays
            with the referee. This page is a design preview; nothing on it is connected yet.
          </p>
          <div className="control-row">
            <button type="button" className="button button--primary" onClick={onOpenStudio}>Back to Studio Desk</button>
            <span className="tag tag--accent">Planned</span>
          </div>
        </div>
        <figure className="var-preview" aria-label="Illustration of a VAR Desk recommendation card">
          <figcaption className="eyebrow">Illustration · not live</figcaption>
          <div className="var-preview__head">
            <span className="live-pill live-pill--running">Review</span>
            <strong>63' · Possible penalty · handball</strong>
          </div>
          <dl className="var-preview__grid">
            <div><dt>Incident</dt><dd>Defender's arm extended away from the body as the cross is blocked (frames 14–16, angles B and D).</dd></div>
            <div><dt>Law</dt><dd>Law 12 · Handling the ball: a hand or arm that makes the body unnaturally bigger is an offence.</dd></div>
            <div><dt>Suggestion</dt><dd>Recommend on-field review. Confidence 0.71.</dd></div>
          </dl>
          <div className="var-preview__foot subtle-text">Officials decide · cited frames and Law passage attached</div>
        </figure>
      </section>

      <Panel eyebrow="How a review would flow" title="From the VAR call to the referee's decision">
        <ol className="var-flow">
          {FLOW.map((step, index) => (
            <li key={step.title} className="var-flow__step">
              <span className="var-flow__index mono">{index + 1}</span>
              <div>
                <strong>{step.title}</strong>
                <span className="pipeline__service">{step.service}</span>
                <p className="subtle-text">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </Panel>

      <div className="var-grid">
        <Panel eyebrow="Already built" title="Reused from the Studio Desk">
          <ul className="plain-list">{REUSED.map((item) => <li key={item}>{item}</li>)}</ul>
        </Panel>
        <Panel eyebrow="Guardrails" title="Officials stay in charge">
          <ul className="plain-list">{GUARDRAILS.map((item) => <li key={item}>{item}</li>)}</ul>
        </Panel>
        <Panel eyebrow="Honest limits" title="What it can't do yet">
          <ul className="plain-list">{LIMITS.map((item) => <li key={item}>{item}</li>)}</ul>
        </Panel>
      </div>
    </main>
  );
}
