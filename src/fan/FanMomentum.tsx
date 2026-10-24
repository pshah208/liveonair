import { useMemo } from "react";
import type { MatchFixture } from "../../shared/types.js";
import { MomentumChart } from "../MomentumChart.js";
import { momentumUpTo } from "../momentumView.js";
import { whyItMattersText } from "../WhyItMatters.js";
import { FAN_TEXT } from "./strings.js";

/**
 * Compact momentum for Fan View: lane A's chart (colour-blind-safe default palette, "illustrative" label and
 * insufficient-coverage state) plus one deterministic why-it-matters line. Never shows anything after `uptoSecond`.
 */
export function FanMomentum({ fixture, uptoSecond, finished }: { fixture: MatchFixture; uptoSecond: number; finished: boolean }) {
  const uptoMinute = finished ? null : Math.floor(Math.max(0, uptoSecond) / 60);
  const events = useMemo(() => fixture.events.filter((event) => event.minute * 60 + event.second <= uptoSecond), [fixture.events, uptoSecond]);
  const series = useMemo(() => momentumUpTo(events, uptoMinute), [events, uptoMinute]);
  const explanation = whyItMattersText({ kind: "momentum", series, events, homeName: fixture.home.name, awayName: fixture.away.name }) ?? undefined;
  return (
    <section className="fan-p2-momentum" aria-labelledby="fan-momentum-title">
      <div className="fan-p2-section__head">
        <span className="eyebrow">{FAN_TEXT.momentumEyebrow}</span>
        <h2 id="fan-momentum-title" className="fan-p2-section__title">{FAN_TEXT.momentumTitle}</h2>
      </div>
      <MomentumChart series={series} homeName={fixture.home.name} awayName={fixture.away.name} compact explanation={explanation} />
      <p className="fan-p2-sponsor">{FAN_TEXT.momentumSponsor}</p>
    </section>
  );
}
